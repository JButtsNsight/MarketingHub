-- cdk/sql/2026-07-05-templates.sql
-- MarketingHub — campaign templates metadata schema (Phase 2).
-- IDEMPOTENT: safe to re-run. Never destructive (no DROP).
-- Template FILES live in the private Supabase Storage bucket `campaign-templates`
-- (S3-backed); this table holds the METADATA + a Postgres full-text `search`
-- column over name/tags/category/body. Only the app server (service_role via
-- PostgREST) touches this schema — never the browser. Cognito is the sole auth.

create schema if not exists marketinghub;

-- gen_random_uuid() comes from pgcrypto (present by default on Supabase Postgres).
create extension if not exists pgcrypto;

create table if not exists marketinghub.templates (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  type         text not null check (type in ('text', 'email')),
  category     text not null,
  tags         text[] not null default '{}',
  subject      text,
  body         text not null,
  storage_path text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, array_to_string(tags, ' ')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(body, '')), 'C')
  ) stored
);

-- Full-text search index (websearch_to_tsquery matches against this).
create index if not exists templates_search_idx
  on marketinghub.templates using gin (search);

-- Fast category browse/filter.
create index if not exists templates_category_idx
  on marketinghub.templates (category);

-- Contains/overlap tag filtering.
create index if not exists templates_tags_idx
  on marketinghub.templates using gin (tags);

-- ---------------------------------------------------------------------------
-- PRIVILEGES — service_role is the ONLY role that touches this schema.
-- A freshly-created custom schema grants NOTHING automatically: Supabase's
-- default-privilege setup covers only public/storage/graphql_public, and
-- service_role is BYPASSRLS but NOT a superuser and NOT the owner of these
-- objects (the migration runs as postgres). Without these grants every
-- PostgREST query fails with `42501 permission denied for schema marketinghub`.
-- All grants are idempotent (safe to re-run).
-- ---------------------------------------------------------------------------
grant usage on schema marketinghub to service_role;
grant all privileges on all tables in schema marketinghub to service_role;
-- Any future tables created in this schema by the migration role also flow to service_role.
alter default privileges in schema marketinghub
  grant all privileges on tables to service_role;

-- ---------------------------------------------------------------------------
-- DENY-BY-DEFAULT RLS (spec §12) — `marketinghub` is exposed to PostgREST
-- (PGRST_DB_SCHEMAS, see docker-compose.override.yml), so the deny-by-default
-- RLS deploy gate covers this table. The application path is service_role
-- (BYPASSRLS) and is UNAFFECTED; anon/authenticated must get ZERO rows.
-- ENABLE + FORCE RLS with an explicit RESTRICTIVE deny-all policy. FORCE does
-- not apply to the superuser postgres role, so migrations/pg_dump are unaffected.
-- ---------------------------------------------------------------------------
alter table marketinghub.templates enable row level security;
alter table marketinghub.templates force row level security;

-- Idempotent (DROP-free) policy creation — safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'marketinghub'
      and tablename  = 'templates'
      and policyname = 'templates_deny_all'
  ) then
    create policy templates_deny_all on marketinghub.templates
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PRIVATE STORAGE BUCKET (deploy runbook — created on first deploy)
-- ---------------------------------------------------------------------------
-- The `campaign-templates` bucket is PRIVATE (public = false). Files are served
-- only through server-mediated signed URLs (service_role). Preferred creation is
-- the Supabase Storage REST API on first deploy:
--
--   POST {SUPABASE_URL}/storage/v1/bucket
--   Authorization: Bearer {SERVICE_ROLE_KEY}
--   { "id": "campaign-templates", "name": "campaign-templates", "public": false }
--
-- Equivalent SQL form (run against the storage schema if creating via psql):
--
--   insert into storage.buckets (id, name, public)
--   values ('campaign-templates', 'campaign-templates', false)
--   on conflict (id) do nothing;
--
-- Do NOT mark this bucket public.
