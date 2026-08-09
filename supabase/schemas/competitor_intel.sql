-- supabase/schemas/competitor_intel.sql
-- Wave 8 — DECLARED END-STATE for the `competitor_intel` schema (the first
-- occupant of the declarative-schema convention, see README.md in this dir).
--
-- This file is the reviewed source of truth for SHAPE ONLY: schema, tables,
-- indexes, functions, triggers. Everything the `supabase db diff` engine
-- cannot produce is hand-written in the applied artifact
-- (cdk/sql/2026-08-08-w8-competitor-intel.sql) and asserted by
-- cdk/test/w8-competitor-intel.test.ts:
--   * RLS enable/force + the policy matrix + the RESTRICTIVE anon deny_all
--     backstops (rls-gate compliance)
--   * the grant/revoke matrix (schema usage, table grants, sequence grants,
--     function EXECUTE)
--   * pgmq queue creation (pgmq.create('ci_embed') — a function call, not DDL
--     the diff can see)
--   * the pg_cron sweep job ('ci_embed_sweep')
--   * comments
-- NEVER apply this file to a real host — deploys go through the dated
-- cdk/sql migration via `docker exec supabase-db psql` as supabase_admin.
--
-- Embeddings are vector(1024): Titan v2's default dimensionality
-- (normalize=true default makes cosine distance correct), well under
-- pgvector's 2,000-dim HNSW indexing limit. The stub provider emits 1024 too.

create schema if not exists competitor_intel;

-- ---------------------------------------------------------------------------
-- sources — a competitor/source registry. kind='url' records a reference URL
-- as METADATA ONLY: URL fetching is NOT shipped in Wave 8 (deferred until the
-- SSRF-safe fetcher lands); ingestion is paste-text only.
-- ---------------------------------------------------------------------------
create table competitor_intel.sources (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  kind       text not null default 'text' check (kind in ('text', 'url')),
  url        text,
  notes      text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- documents — pasted text bodies. status is the embedding pipeline state
-- machine: pending -> processing -> embedded | error. error carries the
-- consumer's failure message for the honest UI state.
-- ---------------------------------------------------------------------------
create table competitor_intel.documents (
  id         uuid primary key default gen_random_uuid(),
  source_id  uuid not null references competitor_intel.sources (id) on delete cascade,
  title      text not null,
  -- Mirrors the app's DOCUMENT_CONTENT_MAX_CHARS (web/src/lib/intel/schema.ts)
  -- DB-side: the zod cap only guards the API route, while `authenticated`
  -- holds unconditional INSERT under RLS.
  content    text not null
             constraint documents_content_len_max
             check (length(content) <= 500000),
  status     text not null default 'pending'
             check (status in ('pending', 'processing', 'embedded', 'error')),
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index documents_source_id_idx on competitor_intel.documents (source_id);

-- ---------------------------------------------------------------------------
-- chunks — the embedded retrieval units. embedding_model records which
-- provider produced the vector (stub vs Bedrock) so search can warn on
-- corpus/query provider mismatch. unique(document_id, seq) makes the
-- consumer's delete-then-insert re-embed idempotent.
-- ---------------------------------------------------------------------------
create table competitor_intel.chunks (
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

create index chunks_document_id_idx on competitor_intel.chunks (document_id);

-- HNSW cosine index (pgvector 0.8.0). m/ef_construction are the library
-- defaults, spelled out so the shape is reviewable.
create index chunks_embedding_hnsw_idx on competitor_intel.chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- ---------------------------------------------------------------------------
-- Embedding queue plumbing: INSERTs and content UPDATEs enqueue a
-- {document_id} job onto pgmq queue 'ci_embed' (SECURITY DEFINER — callers
-- have no pgmq rights); a content UPDATE also resets status to 'pending'.
-- ---------------------------------------------------------------------------
create function competitor_intel.enqueue_document_embed()
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

create function competitor_intel.reset_document_status()
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

create trigger documents_embed_on_insert
  after insert on competitor_intel.documents
  for each row execute function competitor_intel.enqueue_document_embed();

create trigger documents_embed_on_content_update
  after update of content on competitor_intel.documents
  for each row execute function competitor_intel.enqueue_document_embed();

create trigger documents_reset_on_content_update
  before update of content on competitor_intel.documents
  for each row execute function competitor_intel.reset_document_status();

-- ---------------------------------------------------------------------------
-- match_chunks — semantic search RPC. SECURITY INVOKER on purpose: callers
-- see only what RLS grants them. Column names match the app's MatchChunkRow
-- interface (web/src/lib/intel/schema.ts) exactly.
-- ---------------------------------------------------------------------------
create function competitor_intel.match_chunks(
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
