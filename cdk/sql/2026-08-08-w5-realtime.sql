-- cdk/sql/2026-08-08-w5-realtime.sql
-- Supabase parity — Wave 5: Realtime + the edge-functions registry.
--
-- WHAT THIS DOES (all additive — zero app behavior change until the Wave-5
-- app deploy and the ALB /realtime/v1/* rule land):
--   1. Fail-loud guard: realtime.messages / realtime.send() must exist. The
--      realtime container's tenant migrations create them at boot
--      (SEED_SELF_HOST=true) — start the realtime container first. This file
--      never creates realtime-owned objects.
--   2. Realtime tenant hardening: private_only = true on the self-hosted
--      tenant (guarded — NOTICE + skip on a realtime image without the
--      column). Every Wave-5 consumer joins PRIVATE channels only, so
--      nothing built here notices; what it removes is PUBLIC-channel pub/sub
--      for any anon-key holder once /realtime/v1/* is browser-reachable
--      (an unaudited message bus otherwise). The realtime container caches
--      tenant config — the staged apply script restarts it afterwards.
--   3. Private-channel authorization: mh_recv (receive) / mh_send (send)
--      policies for role `authenticated` on realtime.messages,
--      broadcast+presence extensions only. RECEIVE covers all 'mh:%' topics;
--      SEND is scoped to 'mh:inspector:%' ONLY — the live-view topics
--      (mh:inbox / mh:schedule / mh:campaigns / mh:campaign:<id>) are
--      written exclusively by the DB triggers below (as the superuser, which
--      bypasses RLS), so an authenticated user can never forge `change`
--      signals that drive every other user's browser into refresh loops.
--      RLS on realtime.messages is already ENABLED by the tenant
--      migrations — deliberately NOT re-enabled/forced here (realtime owns
--      that table's RLS state; we only attach policies).
--   4. marketinghub.edge_functions — the registry the /functions console
--      reads. App containers can NEVER read the host functions volume, so
--      this table is the console's only source of truth for function source.
--      Read-only for `authenticated`, plus the RESTRICTIVE
--      edge_functions_deny_all anon backstop every marketinghub table
--      carries (the rls-gate release gate blocks without it); ALL writes
--      ride service_role (BYPASSRLS — no write policy needed or wanted) via
--      the staged host script that also writes the volume files.
--   5. Broadcast-from-DB: marketinghub.tg_mh_notify() + AFTER-row triggers.
--      Payloads carry ids ONLY ({table, op, id} — no row data, no PII;
--      receivers re-fetch through their own RLS-gated reads). The trigger
--      body swallows every error — realtime being down, stopped, or
--      misconfigured can never fail user DML.
--
-- DELIBERATELY ABSENT — postgres_changes: this migration adds NO table to
-- the supabase_realtime publication and changes NO replica identity. With
-- Wave-4 RLS granting `authenticated` USING(true) on the live tables,
-- postgres_changes would deliver FULL ROWS (phone_e164, message bodies, the
-- raw inbound-webhook JSON) to any browser holding the anon key + its own
-- user JWT — a bulk PII egress path that defeats the ids-only broadcast
-- design below. No Wave-5 consumer uses postgres_changes; the
-- broadcast-from-DB triggers cover every live view.
--
-- IDEMPOTENT: safe to re-run. Never destructive. Every policy/trigger
-- creation sits behind a catalog-existence guard and the tenant update
-- converges (WHERE ... IS DISTINCT FROM), so re-runs no-op cleanly.
--
-- APPLY AS supabase_admin (the real superuser here; `postgres` is NOT —
-- creating policies on realtime-owned tables and updating the realtime
-- tenant registry need it).
-- Target is the pinned bundle's PG 15.8:
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-08-w4-user-rls.sql (the migration tail —
-- Wave 4 establishes the `authenticated` posture in schema marketinghub,
-- including `grant usage on schema marketinghub to authenticated`, which the
-- edge_functions SELECT grant below assumes) and after the realtime
-- container has booted at least once against this database (see guard).
--
-- TRANSACTIONAL: everything up to the pgrst notify is ONE transaction
-- (begin/commit — w4 precedent). An interrupted apply rolls back whole. The
-- standalone `select pg_notify('pgrst', 'reload schema');` sits OUTSIDE the
-- transaction: NOTIFY only fires at commit anyway, and a standalone
-- statement signals the reload only after the commit above has truly landed.
-- edge_functions is a new table in a PostgREST-exposed schema — do not
-- strip the reload.

begin;

-- ---------------------------------------------------------------------------
-- 1. GUARD — fail loud (and roll back whole) unless the realtime container's
-- tenant migrations have run against this database. They create
-- realtime.messages (daily-partitioned) and realtime.send(); this migration
-- attaches policies and triggers to them but must never create them itself.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise exception 'realtime.messages is missing — start the realtime container first (its tenant migrations create it at boot — this migration never creates realtime-owned objects)';
  end if;
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'realtime'
       and p.proname = 'send'
  ) then
    raise exception 'realtime.send() is missing — start the realtime container first (its tenant migrations create it at boot — this migration never creates realtime-owned objects)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. REALTIME TENANT HARDENING — private_only. The mh_recv/mh_send policies
-- below govern PRIVATE channels only; a tenant that still permits PUBLIC
-- channels would let any anon-key holder pub/sub arbitrary public topics
-- through the browser-reachable /realtime/v1/* route (an unaudited message
-- bus, invisible to the app). Every Wave-5 surface joins private channels
-- exclusively (the wrapper hard-codes private: true), so this changes
-- nothing built here. Guarded: a realtime image without
-- _realtime.tenants.private_only gets a NOTICE and a skip — runbook §10.4
-- records that as an accepted risk, never a failed apply. Converges
-- (IS DISTINCT FROM) so re-runs no-op. The realtime container caches tenant
-- config, so the staged apply script restarts it after this lands.
--
-- (No publication work happens here on purpose — see DELIBERATELY ABSENT in
-- the header: postgres_changes stays off, broadcast-from-DB needs no
-- publication; realtime's broadcast replication slot is self-managed.)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('_realtime.tenants') is not null
     and exists (
       select 1
         from information_schema.columns
        where table_schema = '_realtime'
          and table_name   = 'tenants'
          and column_name  = 'private_only'
     ) then
    update _realtime.tenants
       set private_only = true
     where private_only is distinct from true;
  else
    raise notice 'realtime tenants.private_only not found — PUBLIC channels stay enabled (accepted risk, runbook §10.4)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. PRIVATE-CHANNEL AUTHORIZATION — RLS policies on realtime.messages gate
-- who may receive (SELECT) and send (INSERT) on private channels,
-- broadcast+presence extensions only (never postgres_changes rows).
-- realtime.topic() is the topic being joined.
--
-- RECEIVE (mh_recv): all 'mh:%' topics — every live view and the Inspector
-- subscribe here. SEND (mh_send): 'mh:inspector:%' ONLY. The live-view
-- topics (mh:inbox / mh:schedule / mh:campaigns / mh:campaign:<id>) are
-- written exclusively by the tg_mh_notify triggers below — which run as the
-- superuser and bypass RLS — so no authenticated user can forge `change`
-- events that force every other online user's browser into
-- router.refresh() loops (cross-user DB-load amplification), nor inject
-- junk into other operators' Inspector feeds on those topics. The
-- Inspector's send/presence tester keeps its own scratch namespace.
-- Every other private topic still fails closed (RLS default-deny — `anon`
-- gets nothing at all).
--
-- Deliberately NO enable/force RLS here — the tenant migrations already
-- enabled it and realtime owns that table's RLS state.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename  = 'messages'
      and policyname = 'mh_recv'
  ) then
    create policy mh_recv on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension in ('broadcast', 'presence')
        and realtime.topic() like 'mh:%'
      );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename  = 'messages'
      and policyname = 'mh_send'
  ) then
    create policy mh_send on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension in ('broadcast', 'presence')
        and realtime.topic() like 'mh:inspector:%'
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. EDGE-FUNCTIONS REGISTRY — source of truth for the /functions console.
-- One row per function; `source` mirrors exactly what the staged host script
-- writes to /mnt/pgdata/functions/<name>/index.ts (app containers cannot
-- read that volume). Read-only for `authenticated` (SELECT policy + SELECT
-- grant, w4 matrix style); NO write policies on purpose — every write rides
-- service_role, which has BYPASSRLS (FORCE RLS binds the owner, not
-- BYPASSRLS roles). Plus the RESTRICTIVE anon deny_all backstop below —
-- the committed release gate (cdk/sql/rls-gate.sql, arm
-- NO_RESTRICTIVE_ANON_POLICY) blocks any marketinghub table without one.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.edge_functions (
  name        text primary key,
  source      text not null,
  version     text not null default '0',
  updated_at  timestamptz not null default now(),
  deployed_at timestamptz,
  notes       text
);

-- Revoke-then-grant convergence (w4 precedent): re-runs land on exactly
-- SELECT for authenticated, nothing for anon/public.
revoke all on marketinghub.edge_functions from anon, authenticated, public;

alter table marketinghub.edge_functions enable row level security;
alter table marketinghub.edge_functions force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'edge_functions'
      and policyname = 'edge_functions_authenticated_select'
  ) then
    create policy edge_functions_authenticated_select on marketinghub.edge_functions
      for select to authenticated using (true);
  end if;
end $$;

-- RESTRICTIVE deny-all backstop for anon (W4 user-table style — anon ONLY,
-- so the permissive authenticated SELECT above still yields rows;
-- restrictive policies AND against permissive ones). anon already fails
-- closed via the revoke + RLS default-deny — this is the control-posture
-- backstop the rls-gate requires, so /tmp/apply-w4-rls.sh's documented
-- safe re-run (inline gate, 'must show ZERO rows') stays green after W5.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'edge_functions'
      and policyname = 'edge_functions_deny_all'
  ) then
    create policy edge_functions_deny_all on marketinghub.edge_functions
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

grant select on marketinghub.edge_functions to authenticated;
grant all privileges on marketinghub.edge_functions to service_role;

-- ---------------------------------------------------------------------------
-- 5. BROADCAST-FROM-DB — realtime.send() notifications with ids ONLY.
-- Payload is {table, op, id}: no row data ever crosses the wire (phone
-- numbers, message bodies and raw webhook payloads stay behind the tables'
-- own RLS — live views re-fetch via router.refresh()). Topics:
--   marketinghub.sms_inbound_messages    -> mh:inbox
--   marketinghub.sms_campaigns           -> mh:schedule
--   marketinghub.sms_campaign_recipients -> mh:campaigns
-- plus a per-campaign fan-out to mh:campaign:<campaign_id> whenever the row
-- carries a non-null campaign_id (recipients do; inbound messages use
-- matched_campaign_id and reach campaign detail via mh:inbox instead).
-- The whole body is wrapped begin/exception-when-others-then-null: a
-- broadcast failure must NEVER fail the user's DML. EXECUTE is left at the
-- default on purpose — `returns trigger` functions cannot be called
-- directly, and a fire-time ACL surprise must never block DML.
-- ---------------------------------------------------------------------------
create or replace function marketinghub.tg_mh_notify()
returns trigger
language plpgsql
as $$
declare
  rec     jsonb;
  payload jsonb;
begin
  begin
    rec := to_jsonb(coalesce(new, old));
    payload := jsonb_build_object(
      'table', tg_table_name,
      'op',    tg_op,
      'id',    rec ->> 'id'
    );
    perform realtime.send(payload, 'change', 'mh:' || tg_argv[0], true);
    if (rec ? 'campaign_id') and (rec ->> 'campaign_id') is not null then
      perform realtime.send(payload, 'change', 'mh:campaign:' || (rec ->> 'campaign_id'), true);
    end if;
  exception
    when others then
      -- never fail user DML because realtime is down or misconfigured
      null;
  end;
  return null;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'marketinghub'
       and c.relname = 'sms_inbound_messages'
       and t.tgname  = 'sms_inbound_messages_mh_notify'
  ) then
    create trigger sms_inbound_messages_mh_notify
      after insert or update on marketinghub.sms_inbound_messages
      for each row execute function marketinghub.tg_mh_notify('inbox');
  end if;
end $$;

-- sms_campaigns also broadcasts DELETE: the schedule view must drop
-- campaigns that disappear (e.g. a contact-list cascade).
do $$
begin
  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'marketinghub'
       and c.relname = 'sms_campaigns'
       and t.tgname  = 'sms_campaigns_mh_notify'
  ) then
    create trigger sms_campaigns_mh_notify
      after insert or update or delete on marketinghub.sms_campaigns
      for each row execute function marketinghub.tg_mh_notify('schedule');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'marketinghub'
       and c.relname = 'sms_campaign_recipients'
       and t.tgname  = 'sms_campaign_recipients_mh_notify'
  ) then
    create trigger sms_campaign_recipients_mh_notify
      after insert or update on marketinghub.sms_campaign_recipients
      for each row execute function marketinghub.tg_mh_notify('campaigns');
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- PostgREST caches the schema AND role grants — reload or the new
-- edge_functions surface 404s until restart. Deliberately OUTSIDE the
-- transaction (w4 / scope-pg-net precedent): NOTIFY only fires at commit
-- anyway, and a standalone statement signals the reload only after the
-- commit above has truly landed.
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');
