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
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(tags, ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
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
