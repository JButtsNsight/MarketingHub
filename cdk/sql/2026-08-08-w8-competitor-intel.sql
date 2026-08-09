-- cdk/sql/2026-08-08-w8-competitor-intel.sql
-- Supabase parity — Wave 8: the competitor-intel RAG substrate. First
-- consumer of the declarative-schema convention: the reviewed end-state
-- shape lives in supabase/schemas/competitor_intel.sql; THIS hand-finished
-- file is the applied artifact (the diff engine cannot emit RLS, grants,
-- pgmq.create, pg_cron jobs or comments — all hand-written here).
--
-- WHAT THIS DOES (all additive — zero app behavior change until the Wave-8
-- app deploy + the PGRST_DB_SCHEMAS stage expose the new surfaces):
--   1. Schema competitor_intel with sources / documents / chunks.
--      documents.content carries a 500,000-char CHECK — the app-route zod
--      cap mirrored DB-side, so direct PostgREST writers cannot land rows
--      the worker would endanger itself embedding.
--      chunks.embedding is vector(1024): Titan v2's default dimensionality
--      (normalize=true default makes cosine correct), well under pgvector's
--      2,000-dim HNSW indexing limit; the deterministic stub provider emits
--      1024 too. chunks.embedding_model records WHICH provider produced each
--      vector so search can warn on corpus/query provider mismatch.
--   2. HNSW cosine index on chunks.embedding (pgvector 0.8.0,
--      vector_cosine_ops, m=16 / ef_construction=64 — the library defaults,
--      spelled out to be reviewable). Created inside the transaction: fine
--      at this module's scale (an empty table now; competitor-intel corpora
--      are thousands of chunks, not millions). Build-memory caveat: HNSW
--      builds fastest when the graph fits maintenance_work_mem and the
--      server WARNS at ~100k tuples when it no longer does — on this small
--      host keep maintenance_work_mem at its default and accept a slower
--      build; never crank it toward RAM exhaustion for this index.
--   3. pgmq queue 'ci_embed' — GUARDED: pgmq.create() is NOT idempotent by
--      default (its create table statements are, but re-running the full
--      create also re-runs index/meta DDL paths we do not control), so the
--      call sits behind a to_regclass('pgmq.q_ci_embed') check. The
--      pgmq_public wrapper schema (Wave 1) deliberately has no create()
--      wrapper — queue creation is a migration-time act, as supabase_admin.
--   4. documents triggers: AFTER INSERT and AFTER UPDATE OF content enqueue
--      {document_id} onto 'ci_embed' via a SECURITY DEFINER function
--      (search_path='' — callers need no pgmq rights and cannot be tricked
--      into a different pgmq.send); BEFORE UPDATE OF content resets
--      status='pending' and clears the stale error. Duplicate enqueues are
--      harmless AND cheap: re-embeds are idempotent (delete-then-insert
--      chunks keyed by unique(document_id, seq)) and the consumer archives
--      duplicates for already-'embedded' documents without re-embedding.
--   5. pg_cron sweep 'ci_embed_sweep' (every 10 min): re-enqueues documents
--      stuck 'pending'/'processing' for >10 minutes (worker died mid-batch,
--      message archived without completion, enqueue raced a restart) —
--      BOUNDED: a document with a message still sitting in the queue is
--      skipped (NOT EXISTS on pgmq.q_ci_embed), so an idle/disabled consumer
--      means the queue holds at most one message per document instead of
--      growing every tick forever. Guarded unschedule-then-schedule so
--      re-runs converge on exactly one job. pg_cron runs jobs in the
--      database that scheduled them (cron.database_name = 'postgres' here).
--   6. match_chunks(query_embedding, match_count, filter_source_id) — the
--      semantic-search RPC. sql STABLE **SECURITY INVOKER**: callers see
--      only what RLS + grants give them. Function-level
--      `set hnsw.iterative_scan = relaxed_order` (real at pgvector 0.8.0)
--      keeps filtered queries from starving under the HNSW ef_search cap.
--      OUT column names match the app's MatchChunkRow interface
--      (web/src/lib/intel/schema.ts) exactly.
--   7. RLS: ENABLE + FORCE on all three tables; permissive authenticated
--      ALL on sources+documents, SELECT-only on chunks (chunks are written
--      exclusively by the worker as service_role); RESTRICTIVE anon
--      deny_all backstop on each (rls-gate arms). Revoke-then-grant
--      convergence on the exact grant matrix — including the pgmq_public
--      EXECUTE hardening (revoke the Postgres-default PUBLIC EXECUTE the
--      Wave-1 wrapper migration never removed; service_role stays the only
--      grantee), since this wave is what makes pgmq_public
--      PostgREST-reachable.
--   8. storage.objects / storage.buckets deny-by-default BACKSTOP (rls-gate
--      scoping fix, this wave): both tables are PostgREST-reachable
--      (storage is in PGRST_DB_SCHEMAS) and hold OUR object/bucket metadata,
--      yet carried no policy — the two rows the scoped rls-gate correctly
--      refuses to allowlist. RLS is ensured ENABLED (idempotent no-op where
--      the storage-api migrations already did it) + a RESTRICTIVE anon
--      deny_all lands on each. NEVER FORCE here: the storage-api service
--      role owns these tables and must keep bypassing RLS, and service_role
--      rides BYPASSRLS — behavior is unchanged for every legitimate path
--      (anon/authenticated already got zero rows: RLS with no policies).
--      No storage grants change.
--
-- IDEMPOTENT: safe to re-run. Never destructive. create-if-not-exists +
-- to_regclass/pg_policies/cron.job guards + create-or-replace; the
-- revoke-then-grant block converges on the exact grant matrix (w4/w5/w7
-- precedent), so re-runs no-op cleanly.
--
-- APPLY AS supabase_admin (the real superuser here; `postgres` is NOT).
-- Target is the pinned bundle's PG 15.8:
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-08-w7-backups-vault.sql (the previous
-- migration tail). Lexicographic apply order already sorts this file last;
-- the guard below fails loud if the earlier chain (marketinghub schema,
-- pgmq/vector/pg_cron extensions from the Wave-1 platform migration) has
-- not run.
--
-- TRANSACTIONAL: everything up to the pgrst notify is ONE transaction
-- (begin/commit — w4/w5/w7 precedent). An interrupted apply rolls back
-- whole. The standalone `select pg_notify('pgrst', 'reload schema');` sits
-- OUTSIDE the transaction: NOTIFY only fires at commit anyway, and a
-- standalone statement signals the reload only after the commit above has
-- truly landed. competitor_intel is a soon-to-be PostgREST-exposed schema
-- with authenticated grants — do not strip the reload.

begin;

-- ---------------------------------------------------------------------------
-- 1. GUARD — fail loud (and roll back whole) unless the dated cdk/sql chain
-- has created schema marketinghub AND the Wave-1 platform migration has
-- installed pgmq / vector / pg_cron. This file is the Wave-8 tail; applying
-- it against a bare database would otherwise half-build the module.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regnamespace('marketinghub') is null
     or not exists (select 1 from pg_extension where extname = 'pgmq')
     or not exists (select 1 from pg_extension where extname = 'vector')
     or not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'prerequisites missing (schema marketinghub + extensions pgmq/vector/pg_cron) — apply the dated cdk/sql chain in lexicographic order first (this file is the Wave-8 tail, AFTER 2026-08-08-w7-backups-vault.sql)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. SCHEMA + TABLES
-- ---------------------------------------------------------------------------
create schema if not exists competitor_intel;

-- sources — competitor/source registry. kind='url' records a reference URL
-- as METADATA ONLY: URL fetching is NOT shipped in Wave 8 (deferred until
-- the SSRF-safe fetcher lands); ingestion is paste-text only.
create table if not exists competitor_intel.sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'text' check (kind in ('text', 'url')),
  url        text,
  notes      text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- documents — pasted text bodies. status is the embedding pipeline state
-- machine (pending -> processing -> embedded | error); error carries the
-- consumer's failure message for the honest UI state. updated_at is
-- app-maintained on content edits (repo nowIso() convention) and feeds the
-- sweep's stuck-document detection.
--
-- documents_content_len_max mirrors the app's DOCUMENT_CONTENT_MAX_CHARS
-- (web/src/lib/intel/schema.ts) DB-side: the zod cap only guards the API
-- route, while `authenticated` holds unconditional INSERT via RLS — a direct
-- PostgREST writer could otherwise land an arbitrarily large row whose
-- chunk/embed pass would endanger the 512 MiB worker task (the consumer also
-- dead-letters oversized rows as its own belt-and-suspenders).
create table if not exists competitor_intel.documents (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references competitor_intel.sources (id) on delete cascade,
  title      text not null,
  content    text not null
             constraint documents_content_len_max
             check (length(content) <= 500000),
  status     text not null default 'pending'
             check (status in ('pending', 'processing', 'embedded', 'error')),
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Converge the constraint onto a pre-existing table too (create-if-not-exists
-- skips the DDL above when documents already exists from an earlier apply).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'documents_content_len_max'
      and conrelid = 'competitor_intel.documents'::regclass
  ) then
    alter table competitor_intel.documents
      add constraint documents_content_len_max check (length(content) <= 500000);
  end if;
end $$;

create index if not exists documents_source_id_idx
  on competitor_intel.documents (source_id);

-- chunks — the embedded retrieval units. unique(document_id, seq) makes the
-- consumer's delete-then-insert re-embed idempotent.
create table if not exists competitor_intel.chunks (
  id              bigint generated always as identity primary key,
  document_id     uuid not null references competitor_intel.documents (id) on delete cascade,
  seq             integer not null,
  content         text not null,
  token_estimate  integer not null,
  embedding       vector(1024),
  embedding_model text,
  embedded_at     timestamptz,
  unique (document_id, seq)
);

create index if not exists chunks_document_id_idx
  on competitor_intel.chunks (document_id);

-- HNSW cosine index — see header §2 for the in-transaction / build-memory
-- rationale. NULL embeddings (not-yet-embedded chunks) are simply absent
-- from the graph.
create index if not exists chunks_embedding_hnsw_idx
  on competitor_intel.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- 3. QUEUE — pgmq.create is not idempotent by default; guard on the backing
-- table. Runs as supabase_admin (the pgmq_public wrapper schema has no
-- create() on purpose — queue creation is a migration-time act).
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pgmq.q_ci_embed') is null then
    perform pgmq.create('ci_embed');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. TRIGGERS — enqueue on insert + content update; reset status on content
-- update. SECURITY DEFINER (owner: supabase_admin) with search_path='' so
-- callers need no pgmq rights and every reference is schema-qualified.
-- EXECUTE is revoked below — triggers check EXECUTE at CREATE TRIGGER time
-- (we are the owner), never at fire time, so nobody can call these directly.
-- ---------------------------------------------------------------------------
create or replace function competitor_intel.enqueue_document_embed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pgmq.send('ci_embed', jsonb_build_object('document_id', new.id));
  return new;
end;
$$;

create or replace function competitor_intel.reset_document_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status := 'pending';
  new.error  := null;
  return new;
end;
$$;

create or replace trigger documents_embed_on_insert
  after insert on competitor_intel.documents
  for each row execute function competitor_intel.enqueue_document_embed();

create or replace trigger documents_embed_on_content_update
  after update of content on competitor_intel.documents
  for each row execute function competitor_intel.enqueue_document_embed();

create or replace trigger documents_reset_on_content_update
  before update of content on competitor_intel.documents
  for each row execute function competitor_intel.reset_document_status();

-- ---------------------------------------------------------------------------
-- 5. SWEEP — re-enqueue stuck documents every 10 minutes. Guarded
-- unschedule-then-schedule converges on exactly one job.
--
-- BOUNDED on purpose: the NOT EXISTS arm skips any document that already has
-- a live message in pgmq.q_ci_embed (delivered or not). Without it, a
-- document whose message is sitting undrained (worker not deployed yet,
-- consumer disabled/provider-broken idle, or wedged) would gain one fresh
-- message per sweep tick FOREVER — 144/day/doc of monotonic queue/WAL growth
-- on this small host, and each accumulated duplicate would later cost the
-- consumer a delivery (the duplicate itself is cheap: the consumer archives
-- messages for already-'embedded' docs without re-embedding). With the guard
-- the sweep only re-covers the real gap it exists for — a message that was
-- consumed (archived/dead-lettered mid-crash) without the document reaching
-- a terminal state — and at most ONE outstanding message per document ever
-- originates here. The queue-table read is supabase_admin's (pg_cron runs
-- jobs as the scheduling role); queue depth stays bounded, so the
-- unindexed jsonb probe stays cheap.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ci_embed_sweep') then
    perform cron.unschedule('ci_embed_sweep');
  end if;
  perform cron.schedule(
    'ci_embed_sweep',
    '*/10 * * * *',
    $ci_sweep$
      select pgmq.send('ci_embed', jsonb_build_object('document_id', d.id))
        from competitor_intel.documents d
       where d.status in ('pending', 'processing')
         and d.updated_at < now() - interval '10 minutes'
         and not exists (
           select 1 from pgmq.q_ci_embed q
            where (q.message ->> 'document_id') = d.id::text
         )
    $ci_sweep$
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6. SEARCH RPC — see header §6. SECURITY INVOKER + STABLE; the LIMIT is
-- server-capped at 50 regardless of what the caller asks for.
-- ---------------------------------------------------------------------------
create or replace function competitor_intel.match_chunks(
  query_embedding vector(1024),
  match_count integer default 8,
  filter_source_id uuid default null
)
returns table (
  chunk_id        bigint,
  document_id     uuid,
  source_id       uuid,
  seq             integer,
  content         text,
  similarity      double precision,
  embedding_model text,
  document_title  text,
  source_name     text
)
language sql
stable
security invoker
set hnsw.iterative_scan = relaxed_order
as $$
  select c.id                                   as chunk_id,
         c.document_id                          as document_id,
         d.source_id                            as source_id,
         c.seq                                  as seq,
         c.content                              as content,
         1 - (c.embedding <=> query_embedding)  as similarity,
         c.embedding_model                      as embedding_model,
         d.title                                as document_title,
         s.name                                 as source_name
    from competitor_intel.chunks c
    join competitor_intel.documents d on d.id = c.document_id
    join competitor_intel.sources s on s.id = d.source_id
   where c.embedding is not null
     and (filter_source_id is null or d.source_id = filter_source_id)
   order by c.embedding <=> query_embedding
   limit least(match_count, 50)
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS + POLICIES — ENABLE + FORCE all three; permissive authenticated
-- (ALL on sources/documents, SELECT-only on chunks); RESTRICTIVE anon
-- deny_all backstop each (w4/w5/w7 style — anon ONLY, so the permissive
-- authenticated policies still yield rows; restrictive policies AND against
-- permissive ones).
-- ---------------------------------------------------------------------------
alter table competitor_intel.sources enable row level security;
alter table competitor_intel.sources force row level security;
alter table competitor_intel.documents enable row level security;
alter table competitor_intel.documents force row level security;
alter table competitor_intel.chunks enable row level security;
alter table competitor_intel.chunks force row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'sources'
      and policyname = 'sources_authenticated_all'
  ) then
    create policy sources_authenticated_all on competitor_intel.sources
      for all to authenticated using (true) with check (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'sources'
      and policyname = 'sources_deny_all'
  ) then
    create policy sources_deny_all on competitor_intel.sources
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'documents'
      and policyname = 'documents_authenticated_all'
  ) then
    create policy documents_authenticated_all on competitor_intel.documents
      for all to authenticated using (true) with check (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'documents'
      and policyname = 'documents_deny_all'
  ) then
    create policy documents_deny_all on competitor_intel.documents
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'chunks'
      and policyname = 'chunks_authenticated_select'
  ) then
    create policy chunks_authenticated_select on competitor_intel.chunks
      for select to authenticated using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'competitor_intel'
      and tablename  = 'chunks'
      and policyname = 'chunks_deny_all'
  ) then
    create policy chunks_deny_all on competitor_intel.chunks
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 8. GRANTS — revoke-then-grant convergence (w4/w5/w7 precedent): re-runs
-- land on exactly the matrix below, nothing for anon/public. service_role
-- carries BYPASSRLS but still needs plain table privileges (no default
-- privileges exist in a brand-new schema); it also needs sequence USAGE for
-- the chunks identity column. Function EXECUTE defaults to PUBLIC in
-- Postgres — revoked explicitly on all three functions, then re-granted on
-- match_chunks only.
--
-- pgmq_public EXECUTE hardening (this wave PostgREST-exposes pgmq_public):
-- the Wave-1 migration GRANTed the wrappers to service_role but never
-- revoked the Postgres-DEFAULT PUBLIC EXECUTE, so until now the ONLY thing
-- denying anon/authenticated was their missing schema USAGE — one
-- copy-paste `grant usage on schema pgmq_public to authenticated` (exactly
-- what upstream's "expose queues to client libraries" guide does) away from
-- handing every authenticated JWT SECURITY DEFINER send/read/pop/archive/
-- delete over EVERY pgmq queue. Revoke PUBLIC/anon/authenticated here (and
-- from the schema's default privileges, so future wrappers are born
-- locked), then re-grant service_role exclusively: per-function EXECUTE now
-- gates independently of schema USAGE (two layers, either sufficient).
-- ---------------------------------------------------------------------------
revoke all on competitor_intel.sources from anon, authenticated, public;
revoke all on competitor_intel.documents from anon, authenticated, public;
revoke all on competitor_intel.chunks from anon, authenticated, public;
revoke all on function competitor_intel.enqueue_document_embed() from anon, authenticated, public;
revoke all on function competitor_intel.reset_document_status() from anon, authenticated, public;
revoke all on function competitor_intel.match_chunks(vector, integer, uuid) from anon, authenticated, public;
revoke execute on all functions in schema pgmq_public from public, anon, authenticated;
alter default privileges in schema pgmq_public revoke execute on functions from public;

grant usage on schema competitor_intel to authenticated, service_role;
grant execute on all functions in schema pgmq_public to service_role;
grant select, insert, update, delete on competitor_intel.sources to authenticated;
grant select, insert, update, delete on competitor_intel.documents to authenticated;
grant select on competitor_intel.chunks to authenticated;
grant select, insert, update, delete on competitor_intel.sources to service_role;
grant select, insert, update, delete on competitor_intel.documents to service_role;
grant select, insert, update, delete on competitor_intel.chunks to service_role;
grant usage, select on all sequences in schema competitor_intel to service_role;
grant execute on function competitor_intel.match_chunks(vector, integer, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. STORAGE BACKSTOP (rls-gate scoping fix — see header §8). ENABLE only,
-- NEVER FORCE: the storage-api service role owns these tables and must keep
-- bypassing RLS. No grants change; anon/authenticated behavior is unchanged
-- (RLS with zero permissive policies already denied them everything — this
-- makes the deny-by-default posture explicit and gate-visible).
-- ---------------------------------------------------------------------------
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'objects_deny_all'
  ) then
    create policy objects_deny_all on storage.objects
      as restrictive
      for all
      to anon
      using (false)
      with check (false);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'buckets'
      and policyname = 'buckets_deny_all'
  ) then
    create policy buckets_deny_all on storage.buckets
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
-- competitor_intel surface is visible without a restart once
-- PGRST_DB_SCHEMAS exposes it (staged: /tmp/stage-w8-env.sh). Deliberately
-- OUTSIDE the transaction (w4/w5/w7 precedent): NOTIFY only fires at commit
-- anyway, and a standalone statement signals the reload only after the
-- commit above has truly landed.
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');
