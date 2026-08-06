-- cdk/sql/2026-08-06-console-sql.sql
-- MarketingHub — SQL editor persistence: saved snippets + query history
-- (Studio-parity console). IDEMPOTENT: safe to re-run. Never destructive.
--
-- AFTER APPLY: run `select pg_notify('pgrst', 'reload schema');` — PostgREST
-- caches the schema, and the new tables 404 until it reloads.

create schema if not exists marketinghub;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- console_snippets — named, saved SQL (Studio's "saved queries"). Snippets
-- are shared across the marketing group (same model as Studio's project
-- scope); created_by records provenance.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.console_snippets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  sql        text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists console_snippets_updated_idx
  on marketinghub.console_snippets (updated_at desc);

-- ---------------------------------------------------------------------------
-- console_query_history — one row per SQL-editor run (who/what/when/outcome).
-- This doubles as the audit trail for the console's superuser query surface:
-- pg-meta executes as supabase_admin, so the history row is the evidence of
-- what was run and by whom.
-- ---------------------------------------------------------------------------
create table if not exists marketinghub.console_query_history (
  id          uuid primary key default gen_random_uuid(),
  sql         text not null,
  ran_by      text not null,
  ran_at      timestamptz not null default now(),
  duration_ms int,
  row_count   int,
  error       text
);

create index if not exists console_query_history_ran_at_idx
  on marketinghub.console_query_history (ran_at desc);

-- ---------------------------------------------------------------------------
-- PRIVILEGES — service_role is the ONLY role that touches this schema
-- (idempotent re-assert, order-independent from the earlier migrations).
-- ---------------------------------------------------------------------------
grant usage on schema marketinghub to service_role;
grant all privileges on all tables in schema marketinghub to service_role;
alter default privileges in schema marketinghub
  grant all privileges on tables to service_role;

-- ---------------------------------------------------------------------------
-- DENY-BY-DEFAULT RLS (spec §12) — same pattern as every marketinghub table:
-- ENABLE + FORCE + explicit RESTRICTIVE deny-all for anon/authenticated.
-- service_role (BYPASSRLS) is unaffected.
-- ---------------------------------------------------------------------------
alter table marketinghub.console_snippets enable row level security;
alter table marketinghub.console_snippets force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'console_snippets'
      and policyname = 'console_snippets_deny_all'
  ) then
    create policy console_snippets_deny_all on marketinghub.console_snippets
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

alter table marketinghub.console_query_history enable row level security;
alter table marketinghub.console_query_history force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'console_query_history'
      and policyname = 'console_query_history_deny_all'
  ) then
    create policy console_query_history_deny_all on marketinghub.console_query_history
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;
