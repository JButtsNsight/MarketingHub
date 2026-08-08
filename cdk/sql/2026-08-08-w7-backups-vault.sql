-- cdk/sql/2026-08-08-w7-backups-vault.sql
-- Supabase parity — Wave 7: the backups-status landing table + the vault
-- console's metadata-only audit trail.
--
-- WHAT THIS DOES (all additive — zero app behavior change until the Wave-7
-- console pages consume these surfaces):
--   1. marketinghub.backup_status — single-row landing table for the
--      /database/backups console. The app can never run host commands
--      (network truth), so a 15-minute HOST cron
--      (/usr/local/bin/backup-status-cron — cdk/assets, installed on first
--      boot by bootstrap setup_backups and on the CURRENT host by the staged
--      /tmp/install-backup-status-cron.sh) runs
--      `pgbackrest --stanza=supabase info --output=json` on the host and
--      upserts the VERBATIM JSON array here via
--      `docker exec supabase-db psql -U postgres`. Latest-only by design
--      (id = 1 CHECK): the row mirrors current status; history lives in
--      pgBackRest's own repo. The payload lands whatever status.code says —
--      the console renders an unhealthy stanza honestly instead of the
--      reporter masking it.
--      Grants: SELECT, INSERT, UPDATE to postgres — the host writer. The
--      pinned image's postgres role carries BYPASSRLS (verified live on
--      supabase/postgres:15.8.1.085), so the FORCE RLS below never blocks
--      the cron. postgres also needs USAGE on the schema: every earlier
--      migration runs as supabase_admin and granted schema usage only to
--      service_role / authenticated / supabase_auth_admin, never postgres.
--      SELECT to authenticated through a permissive policy: backup labels,
--      sizes and timestamps are ops-sensitive but not PII — the console's
--      own auth gate is the real gate. RESTRICTIVE anon deny_all backstop
--      keeps the committed release gate (cdk/sql/rls-gate.sql) green.
--   2. marketinghub.vault_console_audit — METADATA-ONLY audit trail for the
--      /integrations/vault console (create | update | delete | reveal).
--      There is NO value column and there never will be: decrypted secrets
--      must never be logged, cached, audited or persisted (vault contract).
--      Writes arrive via pg-meta as supabase_admin (superuser — needs no
--      grant); anon/authenticated get NO grants at all, so audit rows are
--      readable only through the console's supabase_admin-backed query
--      paths. ENABLE + FORCE RLS with the RESTRICTIVE anon deny_all
--      backstop — pg_policies counts it, so both rls-gate arms
--      (NO_POLICIES and NO_RESTRICTIVE_ANON_POLICY) stay green.
--
-- IDEMPOTENT: safe to re-run. Never destructive. create table if not exists
-- + pg_policies guards; revoke-then-grant converges on the exact grant
-- matrix (w4/w5 precedent), so re-runs no-op cleanly.
--
-- APPLY AS supabase_admin (the real superuser here; `postgres` is NOT).
-- Target is the pinned bundle's PG 15.8:
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-08-w5-realtime.sql (the migration tail —
-- Wave 6 shipped no migration). Lexicographic apply order already sorts
-- this file last; the guard below fails loud if the earlier chain (which
-- creates schema marketinghub) has not run.
--
-- TRANSACTIONAL: everything up to the pgrst notify is ONE transaction
-- (begin/commit — w4/w5 precedent). An interrupted apply rolls back whole.
-- The standalone `select pg_notify('pgrst', 'reload schema');` sits OUTSIDE
-- the transaction: NOTIFY only fires at commit anyway, and a standalone
-- statement signals the reload only after the commit above has truly
-- landed. backup_status is a new table in a PostgREST-exposed schema with
-- an authenticated SELECT grant — do not strip the reload.

begin;

-- ---------------------------------------------------------------------------
-- 1. GUARD — fail loud (and roll back whole) unless the dated cdk/sql chain
-- has created schema marketinghub. This file is the Wave-7 tail; applying it
-- against a bare database would otherwise plant tables in a schema that the
-- earlier migrations own the posture of.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regnamespace('marketinghub') is null then
    raise exception 'schema marketinghub is missing — apply the dated cdk/sql chain in lexicographic order first (this file is the Wave-7 tail, AFTER 2026-08-08-w5-realtime.sql)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. BACKUP STATUS — the host reporter's landing table. Exactly one row
-- (id = 1 CHECK): the reporter upserts `pgbackrest info --output=json`
-- verbatim every 15 minutes; the console derives stanza health, the backup
-- list and the PITR band from it and treats a missing/empty table as its
-- honest "host reporter not installed" empty state.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.backup_status (
  id          smallint primary key default 1 check (id = 1),
  payload     jsonb not null,
  captured_at timestamptz not null default now()
);

-- Revoke-then-grant convergence (w4/w5 precedent): re-runs land on exactly
-- the matrix below, nothing for anon/public.
revoke all on marketinghub.backup_status from anon, authenticated, public;

alter table marketinghub.backup_status enable row level security;
alter table marketinghub.backup_status force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'backup_status'
      and policyname = 'backup_status_authenticated_select'
  ) then
    create policy backup_status_authenticated_select on marketinghub.backup_status
      for select to authenticated using (true);
  end if;
end $$;

-- RESTRICTIVE deny-all backstop for anon (w4/w5 style — anon ONLY, so the
-- permissive authenticated SELECT above still yields rows; restrictive
-- policies AND against permissive ones). anon already fails closed via the
-- revoke + RLS default-deny — this is the control-posture backstop the
-- rls-gate requires.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'backup_status'
      and policyname = 'backup_status_deny_all'
  ) then
    create policy backup_status_deny_all on marketinghub.backup_status
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

-- Host-writer grants. USAGE first: postgres has never been granted schema
-- access by any earlier migration (they all apply as supabase_admin). No
-- DELETE on purpose — the reporter only upserts the singleton row.
grant usage on schema marketinghub to postgres;
grant select, insert, update on marketinghub.backup_status to postgres;
grant select on marketinghub.backup_status to authenticated;

-- ---------------------------------------------------------------------------
-- 3. VAULT CONSOLE AUDIT — one metadata row per console action on a vault
-- secret (create | update | delete | reveal). METADATA ONLY: secret ids and
-- names identify WHAT was touched, actor/action/created_at say WHO/HOW/WHEN.
-- The plaintext value never appears here, in any log, or in any error —
-- that is the vault contract, not a style preference. secret_id/secret_name
-- are nullable: a delete of an unnamed secret has no name to record, and
-- the audit path nulls (rather than rejects) a malformed id so the metadata
-- row can still land. App-side semantics (lib/console/vault.ts): the REVEAL
-- audit is FAIL-CLOSED — the row is inserted before the decrypt and a
-- failed insert refuses the reveal (so reveal ATTEMPTS are recorded too);
-- create/update/delete audits are best-effort.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.vault_console_audit (
  id          bigint generated always as identity primary key,
  secret_id   uuid,
  secret_name text,
  actor       text not null,
  action      text not null check (action in ('create', 'update', 'delete', 'reveal')),
  created_at  timestamptz not null default now()
);

-- No grants at all: pg-meta writes (and the console reads) as supabase_admin,
-- a superuser. anon/authenticated never see audit rows through PostgREST.
revoke all on marketinghub.vault_console_audit from anon, authenticated, public;

alter table marketinghub.vault_console_audit enable row level security;
alter table marketinghub.vault_console_audit force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'vault_console_audit'
      and policyname = 'vault_console_audit_deny_all'
  ) then
    create policy vault_console_audit_deny_all on marketinghub.vault_console_audit
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- PostgREST caches the schema AND role grants — reload so the new
-- backup_status surface (authenticated SELECT) is visible without a restart.
-- Deliberately OUTSIDE the transaction (w4/w5 precedent): NOTIFY only fires
-- at commit anyway, and a standalone statement signals the reload only after
-- the commit above has truly landed.
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');
