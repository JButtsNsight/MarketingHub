-- cdk/sql/2026-08-10-w8-intel-fts.sql
-- Supabase parity — Wave 8R: full-text candidate retrieval for the intel
-- agentic search path. Postgres FTS over competitor_intel.chunks produces
-- ranked candidate passages; the headless-claude gateway reranks and
-- synthesizes the answer app-side. The pgvector pipeline from
-- 2026-08-08-w8-competitor-intel.sql (chunks.embedding, the HNSW index,
-- the ci_embed queue/triggers/sweep, match_chunks) stays DORMANT and
-- UNTOUCHED — it is the parity demonstration; search simply stops calling
-- it. Nothing here drops, alters or supersedes any of that DDL.
--
-- WHAT THIS DOES (all additive — zero app behavior change until the
-- Wave-8R app deploy ships the route that calls the new RPC):
--   1. Expression GIN index on to_tsvector('english', content) over
--      competitor_intel.chunks. The RPC's WHERE clause textually matches
--      this exact expression (including the 'english' regconfig) so the
--      planner can use the index — same websearch_to_tsquery + GIN pairing
--      as the in-repo FTS precedent (cdk/sql/2026-07-05-templates.sql).
--      Created inside the transaction: fine at this module's scale
--      (competitor-intel corpora are thousands of chunks, not millions).
--   2. search_chunks_fts(query_text, match_count, filter_source_id) — the
--      keyword-candidate RPC. sql STABLE **SECURITY INVOKER**: callers see
--      only what RLS + grants give them (authenticated holds SELECT on
--      chunks; the RESTRICTIVE anon deny_all backstop stays armed). OUT
--      column names match the app's FtsChunkRow interface
--      (web/src/lib/intel/schema.ts) exactly; the signature is FROZEN —
--      repo layer and tests depend on it. websearch_to_tsquery never
--      throws on arbitrary user input; a stopword-only query yields an
--      empty tsquery and therefore zero rows (the app handles that as
--      no-candidates). LIMIT is server-clamped to 1..50 regardless of what
--      the caller asks for.
--   3. Grants: revoke-then-grant convergence mirroring match_chunks —
--      EXECUTE defaults to PUBLIC in Postgres, so it is revoked explicitly
--      and re-granted to authenticated + service_role only.
--
-- IDEMPOTENT: safe to re-run. Never destructive. create-index-if-not-exists
-- + create-or-replace; the revoke-then-grant block converges on the exact
-- grant matrix (w4/w5/w7/w8 precedent), so re-runs no-op cleanly.
--
-- APPLY AS supabase_admin (the real superuser here; `postgres` is NOT).
-- Target is the pinned bundle's PG 15.8:
--   docker exec -i supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f <file>
--
-- ORDERING: apply AFTER 2026-08-08-w8-competitor-intel.sql (the previous
-- migration tail — it creates the tables this file indexes and queries).
-- Lexicographic apply order already sorts this file last; the guard below
-- fails loud if the Wave-8 chain has not run.
--
-- TRANSACTIONAL: everything up to the pgrst notify is ONE transaction
-- (begin/commit — w4/w5/w7/w8 precedent). An interrupted apply rolls back
-- whole. The standalone `select pg_notify('pgrst', 'reload schema');` sits
-- OUTSIDE the transaction: NOTIFY only fires at commit anyway, and a
-- standalone statement signals the reload only after the commit above has
-- truly landed. search_chunks_fts is a PostgREST-exposed RPC with
-- authenticated EXECUTE — do not strip the reload.

begin;

-- ---------------------------------------------------------------------------
-- 1. GUARD — fail loud (and roll back whole) unless
-- 2026-08-08-w8-competitor-intel.sql has created the competitor_intel
-- tables this file indexes and joins. Applying against a bare database
-- would otherwise half-build the module.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('competitor_intel.chunks') is null
     or to_regclass('competitor_intel.documents') is null
     or to_regclass('competitor_intel.sources') is null then
    raise exception 'prerequisites missing (competitor_intel.sources/documents/chunks) — apply the dated cdk/sql chain in lexicographic order first (this file is the Wave-8R tail, AFTER 2026-08-08-w8-competitor-intel.sql)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. FTS INDEX — expression GIN. The RPC's WHERE clause below repeats this
-- expression VERBATIM (to_tsvector('english', content) on chunks rows) so
-- the index is usable; change one and you must change both.
-- ---------------------------------------------------------------------------
create index if not exists chunks_content_fts_idx
  on competitor_intel.chunks
  using gin (to_tsvector('english', content));

-- ---------------------------------------------------------------------------
-- 3. SEARCH RPC — see header §2. Signature and OUT columns are FROZEN
-- (web/src/lib/intel/schema.ts FtsChunkRow + repo.ts searchChunksFts).
-- SECURITY INVOKER + STABLE; LIMIT server-clamped to 1..50.
-- ---------------------------------------------------------------------------
create or replace function competitor_intel.search_chunks_fts(
  query_text text,
  match_count integer default 16,
  filter_source_id uuid default null
)
returns table (
  chunk_id        bigint,
  document_id     uuid,
  source_id       uuid,
  seq             integer,
  content         text,
  rank            double precision,
  document_title  text,
  source_name     text
)
language sql
stable
security invoker
as $$
  select c.id          as chunk_id,
         c.document_id as document_id,
         d.source_id   as source_id,
         c.seq         as seq,
         c.content     as content,
         ts_rank_cd(
           to_tsvector('english', c.content),
           websearch_to_tsquery('english', query_text)
         )::double precision as rank,
         d.title       as document_title,
         s.name        as source_name
    from competitor_intel.chunks c
    join competitor_intel.documents d on d.id = c.document_id
    join competitor_intel.sources s on s.id = d.source_id
   where to_tsvector('english', c.content) @@ websearch_to_tsquery('english', query_text)
     and (filter_source_id is null or d.source_id = filter_source_id)
   order by rank desc, c.id
   limit least(greatest(match_count, 1), 50)
$$;

-- ---------------------------------------------------------------------------
-- 4. GRANTS — revoke-then-grant convergence (mirrors match_chunks):
-- function EXECUTE defaults to PUBLIC in Postgres, revoked explicitly, then
-- re-granted to authenticated + service_role only. SECURITY INVOKER keeps
-- RLS in force for authenticated callers.
-- ---------------------------------------------------------------------------
revoke all on function competitor_intel.search_chunks_fts(text, integer, uuid) from anon, authenticated, public;

grant execute on function competitor_intel.search_chunks_fts(text, integer, uuid) to authenticated, service_role;

commit;

-- ---------------------------------------------------------------------------
-- PostgREST caches the schema AND role grants — reload so the new RPC is
-- visible without a restart (competitor_intel is already in
-- PGRST_DB_SCHEMAS since the Wave-8 env stage). Deliberately OUTSIDE the
-- transaction (w4/w5/w7/w8 precedent): NOTIFY only fires at commit anyway,
-- and a standalone statement signals the reload only after the commit above
-- has truly landed.
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');
