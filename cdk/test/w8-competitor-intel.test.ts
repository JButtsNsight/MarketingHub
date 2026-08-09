import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const repo = path.join(root, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const readRepo = (p: string) => fs.readFileSync(path.join(repo, p), 'utf8');

describe('2026-08-08-w8-competitor-intel.sql migration', () => {
  const sql = read('sql/2026-08-08-w8-competitor-intel.sql');
  // Comment-stripped view of the file: the structural assertions below must
  // match executable SQL, never prose in `--` comments.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  test('fails loud unless the chain created marketinghub + pgmq/vector/pg_cron', () => {
    expect(code).toMatch(/to_regnamespace\('marketinghub'\) is null/i);
    expect(code).toMatch(/pg_extension where extname = 'pgmq'/i);
    expect(code).toMatch(/pg_extension where extname = 'vector'/i);
    expect(code).toMatch(/pg_extension where extname = 'pg_cron'/i);
    const raises = code.match(/raise exception/gi) ?? [];
    expect(raises.length).toBe(1);
    // the operator instruction: apply the earlier chain first
    expect(code).toMatch(/apply the dated cdk\/sql chain/i);
  });

  test('is idempotent and never drops, truncates, deletes or disables anything', () => {
    expect(code).toMatch(/create schema if not exists competitor_intel\b/i);
    for (const t of ['sources', 'documents', 'chunks']) {
      expect(code).toMatch(
        new RegExp(`create table if not exists competitor_intel\\.${t}\\b`, 'i')
      );
    }
    expect(code).toMatch(/create index if not exists documents_source_id_idx/i);
    expect(code).toMatch(/create index if not exists chunks_document_id_idx/i);
    expect(code).toMatch(/create index if not exists chunks_embedding_hnsw_idx/i);
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/drop\s+schema/i);
    expect(code).not.toMatch(/drop\s+policy/i);
    expect(code).not.toMatch(/drop\s+function/i);
    expect(code).not.toMatch(/drop\s+trigger/i);
    expect(code).not.toMatch(/drop\s+index/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/delete\s+from/i);
    expect(code).not.toMatch(/disable\s+(row level security|trigger)/i);
  });

  test('sources: contract DDL — uuid pk, kind check, created_by auth.uid()', () => {
    const ddlStart = code.indexOf(
      'create table if not exists competitor_intel.sources'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/id\s+uuid primary key default gen_random_uuid\(\)/i);
    expect(ddl).toMatch(/name\s+text not null/i);
    expect(ddl).toMatch(
      /kind\s+text not null default 'text' check \(kind in \('text', 'url'\)\)/i
    );
    expect(ddl).toMatch(/url\s+text/i);
    expect(ddl).toMatch(/notes\s+text/i);
    expect(ddl).toMatch(/created_by\s+uuid default auth\.uid\(\)/i);
    expect(ddl).toMatch(/created_at\s+timestamptz not null default now\(\)/i);
    expect(ddl).toMatch(/updated_at\s+timestamptz not null default now\(\)/i);
  });

  test('documents: contract DDL — cascade fk, pipeline status check, error column', () => {
    const ddlStart = code.indexOf(
      'create table if not exists competitor_intel.documents'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(
      /source_id\s+uuid not null references competitor_intel\.sources \(id\) on delete cascade/i
    );
    expect(ddl).toMatch(/title\s+text not null/i);
    expect(ddl).toMatch(/content\s+text not null/i);
    expect(ddl).toMatch(
      /status\s+text not null default 'pending'\s+check \(status in \('pending', 'processing', 'embedded', 'error'\)\)/i
    );
    expect(ddl).toMatch(/error\s+text/i);
  });

  test('documents.content: 500k-char CHECK DB-side (zod-cap mirror), converged for pre-existing tables too', () => {
    // In the CREATE TABLE itself (fresh applies)…
    const ddlStart = code.indexOf(
      'create table if not exists competitor_intel.documents'
    );
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(
      /constraint documents_content_len_max\s+check \(length\(content\) <= 500000\)/i
    );
    // …and via a pg_constraint-guarded ALTER for tables from earlier applies.
    const guardStart = code.indexOf("conname = 'documents_content_len_max'");
    expect(guardStart).toBeGreaterThan(-1);
    const guard = code.slice(guardStart, code.indexOf('end $$', guardStart));
    expect(guard).toMatch(
      /alter table competitor_intel\.documents\s+add constraint documents_content_len_max check \(length\(content\) <= 500000\)/i
    );
  });

  test('chunks: contract DDL — identity pk, vector(1024), provider column, unique(document_id, seq)', () => {
    const ddlStart = code.indexOf(
      'create table if not exists competitor_intel.chunks'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/id\s+bigint generated always as identity primary key/i);
    expect(ddl).toMatch(
      /document_id\s+uuid not null references competitor_intel\.documents \(id\) on delete cascade/i
    );
    expect(ddl).toMatch(/seq\s+integer not null/i);
    expect(ddl).toMatch(/token_estimate\s+integer not null/i);
    // Titan v2 default dims; nullable — chunks await the worker's embed pass
    expect(ddl).toMatch(/embedding\s+vector\(1024\)/i);
    expect(ddl).toMatch(/embedding_model\s+text/i);
    expect(ddl).toMatch(/embedded_at\s+timestamptz/i);
    // delete-then-insert re-embeds converge on this key
    expect(ddl).toMatch(/unique \(document_id, seq\)/i);
  });

  test('HNSW cosine index per contract: vector_cosine_ops, m=16, ef_construction=64', () => {
    const idxStart = code.indexOf('create index if not exists chunks_embedding_hnsw_idx');
    expect(idxStart).toBeGreaterThan(-1);
    const idx = code.slice(idxStart, code.indexOf(';', idxStart));
    expect(idx).toMatch(
      /using hnsw \(embedding vector_cosine_ops\) with \(m = 16, ef_construction = 64\)/i
    );
    // the build-memory caveat is documented in the header comments
    expect(sql).toMatch(/maintenance_work_mem/);
  });

  test("queue: pgmq.create('ci_embed') is GUARDED (pgmq.create is not idempotent)", () => {
    const guardStart = code.indexOf("to_regclass('pgmq.q_ci_embed') is null");
    expect(guardStart).toBeGreaterThan(-1);
    const block = code.slice(guardStart, code.indexOf('end $$', guardStart));
    expect(block).toMatch(/perform pgmq\.create\('ci_embed'\)/i);
    // exactly one create call, and only behind the guard
    expect(code.match(/pgmq\.create\(/gi)?.length).toBe(1);
  });

  test('triggers: enqueue on INSERT + UPDATE OF content, reset BEFORE UPDATE OF content', () => {
    expect(code).toMatch(
      /create or replace trigger documents_embed_on_insert\s+after insert on competitor_intel\.documents\s+for each row execute function competitor_intel\.enqueue_document_embed\(\)/i
    );
    expect(code).toMatch(
      /create or replace trigger documents_embed_on_content_update\s+after update of content on competitor_intel\.documents\s+for each row execute function competitor_intel\.enqueue_document_embed\(\)/i
    );
    expect(code).toMatch(
      /create or replace trigger documents_reset_on_content_update\s+before update of content on competitor_intel\.documents\s+for each row execute function competitor_intel\.reset_document_status\(\)/i
    );
  });

  test("enqueue fn: SECURITY DEFINER, empty search_path, sends {document_id} to 'ci_embed'", () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.enqueue_document_embed()'
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = ''/i);
    expect(fn).toMatch(
      /perform pgmq\.send\('ci_embed', jsonb_build_object\('document_id', new\.id\)\)/i
    );
  });

  test("reset fn: flips status back to 'pending' and clears the stale error", () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.reset_document_status()'
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/new\.status := 'pending'/i);
    expect(fn).toMatch(/new\.error\s+:= null/i);
    // no definer needed — it only mutates NEW
    expect(fn).not.toMatch(/security definer/i);
  });

  test('sweep: guarded unschedule-then-schedule, */10 cadence, re-enqueues stuck docs only', () => {
    expect(code).toMatch(
      /if exists \(select 1 from cron\.job where jobname = 'ci_embed_sweep'\)/i
    );
    expect(code).toMatch(/perform cron\.unschedule\('ci_embed_sweep'\)/i);
    const schedStart = code.indexOf("cron.schedule(");
    expect(schedStart).toBeGreaterThan(-1);
    const sched = code.slice(schedStart, code.indexOf('end $$', schedStart));
    expect(sched).toMatch(/'ci_embed_sweep',\s*'\*\/10 \* \* \* \*'/);
    expect(sched).toMatch(
      /select pgmq\.send\('ci_embed', jsonb_build_object\('document_id', d\.id\)\)/i
    );
    expect(sched).toMatch(/status in \('pending', 'processing'\)/i);
    expect(sched).toMatch(/updated_at < now\(\) - interval '10 minutes'/i);
    // the sweep only ENQUEUES — it never mutates documents or the queue
    expect(sched).not.toMatch(/\bupdate\s+competitor_intel/i);
    expect(sched).not.toMatch(/pgmq\.(delete|archive|purge)/i);
  });

  test('sweep is BOUNDED: skips documents that still have a message in the queue', () => {
    // Without this NOT EXISTS arm, an undrained consumer (not deployed,
    // disabled, provider-broken idle, or wedged) means +1 message per doc
    // per sweep tick FOREVER — monotonic pgmq/WAL growth that defeats the
    // "honest idle" degradation contract.
    const schedStart = code.indexOf("cron.schedule(");
    const sched = code.slice(schedStart, code.indexOf('end $$', schedStart));
    expect(sched).toMatch(
      /not exists \(\s*select 1 from pgmq\.q_ci_embed q\s*where \(q\.message ->> 'document_id'\) = d\.id::text\s*\)/i
    );
  });

  test('match_chunks: contract signature + MatchChunkRow column names in order', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.match_chunks('
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/query_embedding vector\(1024\)/i);
    expect(fn).toMatch(/match_count integer default 8/i);
    expect(fn).toMatch(/filter_source_id uuid default null/i);
    // OUT columns must match web/src/lib/intel/schema.ts MatchChunkRow exactly
    const returns = fn.slice(fn.indexOf('returns table'), fn.indexOf('language sql'));
    const cols = [...returns.matchAll(/^\s*(\w+)\s+[\w ]+,?$/gim)].map((m) => m[1]);
    expect(cols).toEqual([
      'chunk_id',
      'document_id',
      'source_id',
      'seq',
      'content',
      'similarity',
      'embedding_model',
      'document_title',
      'source_name',
    ]);
  });

  test('match_chunks: sql STABLE SECURITY INVOKER with relaxed_order iterative scan', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.match_chunks('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/language sql\s+stable\s+security invoker/i);
    // pgvector 0.8.0 iterative scans — helps filtered queries under HNSW
    expect(fn).toMatch(/set hnsw\.iterative_scan = relaxed_order/i);
    expect(fn).toMatch(/where c\.embedding is not null/i);
    expect(fn).toMatch(/1 - \(c\.embedding <=> query_embedding\)\s+as similarity/i);
    expect(fn).toMatch(/order by c\.embedding <=> query_embedding/i);
    // server-side cap regardless of caller input
    expect(fn).toMatch(/limit least\(match_count, 50\)/i);
    expect(fn).toMatch(
      /filter_source_id is null or d\.source_id = filter_source_id/i
    );
  });

  test('RLS: ENABLE + FORCE on all three competitor_intel tables', () => {
    for (const t of ['sources', 'documents', 'chunks']) {
      expect(code).toMatch(
        new RegExp(`alter table competitor_intel\\.${t} enable row level security`, 'i')
      );
      expect(code).toMatch(
        new RegExp(`alter table competitor_intel\\.${t} force row level security`, 'i')
      );
    }
  });

  test('every CREATE POLICY sits behind a pg_policies if-not-exists guard', () => {
    const creates = code.match(/create policy/gi) ?? [];
    const guards =
      code.match(/if not exists\s*\(\s*select 1 from pg_policies/gi) ?? [];
    // 3× authenticated + 3× deny_all on competitor_intel, 2× storage backstop
    expect(creates.length).toBe(8);
    expect(guards.length).toBe(creates.length);
  });

  test('policy matrix: authenticated ALL on sources+documents, SELECT-only on chunks', () => {
    for (const t of ['sources', 'documents']) {
      const start = code.indexOf(
        `create policy ${t}_authenticated_all on competitor_intel.${t}`
      );
      expect(start).toBeGreaterThan(-1);
      const pol = code.slice(start, code.indexOf(';', start));
      expect(pol).toMatch(
        /for all to authenticated using \(true\) with check \(true\)/i
      );
    }
    const start = code.indexOf(
      'create policy chunks_authenticated_select on competitor_intel.chunks'
    );
    expect(start).toBeGreaterThan(-1);
    const pol = code.slice(start, code.indexOf(';', start));
    expect(pol).toMatch(/for select to authenticated using \(true\)/i);
    expect(pol).not.toMatch(/with check/i);
    // chunks are worker-written (service_role): no permissive write policy ever
    expect(code).not.toMatch(
      /competitor_intel\.chunks\s+for (insert|update|delete|all)\b/i
    );
  });

  test('release gate: all three tables carry the RESTRICTIVE anon deny_all backstop', () => {
    for (const table of ['sources', 'documents', 'chunks']) {
      const denyStart = code.indexOf(
        `create policy ${table}_deny_all on competitor_intel.${table}`
      );
      expect(denyStart).toBeGreaterThan(-1);
      const deny = code.slice(denyStart, code.indexOf(';', denyStart));
      expect(deny).toMatch(
        /as restrictive\s+for all\s+to anon\s+using \(false\)\s+with check \(false\)/i
      );
      // anon ONLY — a restrictive policy naming authenticated would AND-block
      // the permissive policies and blank the intel pages.
      expect(deny).not.toMatch(/authenticated/i);
      expect(deny).not.toMatch(/to anon\s*,/i);
    }
  });

  test('grant matrix: revoke-then-grant convergence, enumerated exactly, nothing to anon/public', () => {
    for (const t of ['sources', 'documents', 'chunks']) {
      expect(code).toMatch(
        new RegExp(
          `revoke all on competitor_intel\\.${t} from anon, authenticated, public`,
          'i'
        )
      );
    }
    // function EXECUTE defaults to PUBLIC — all three get the revoke
    expect(code).toMatch(
      /revoke all on function competitor_intel\.enqueue_document_embed\(\) from anon, authenticated, public/i
    );
    expect(code).toMatch(
      /revoke all on function competitor_intel\.reset_document_status\(\) from anon, authenticated, public/i
    );
    expect(code).toMatch(
      /revoke all on function competitor_intel\.match_chunks\(vector, integer, uuid\) from anon, authenticated, public/i
    );
    // enumerate EVERY grant in the file — nothing extra may sneak in.
    const grants = (code.match(/grant [^;]+;/gi) ?? []).map((g) =>
      g.replace(/\s+/g, ' ').toLowerCase()
    );
    expect(grants.sort()).toEqual(
      [
        'grant usage on schema competitor_intel to authenticated, service_role;',
        'grant select, insert, update, delete on competitor_intel.sources to authenticated;',
        'grant select, insert, update, delete on competitor_intel.documents to authenticated;',
        'grant select on competitor_intel.chunks to authenticated;',
        'grant select, insert, update, delete on competitor_intel.sources to service_role;',
        'grant select, insert, update, delete on competitor_intel.documents to service_role;',
        'grant select, insert, update, delete on competitor_intel.chunks to service_role;',
        'grant usage, select on all sequences in schema competitor_intel to service_role;',
        'grant execute on function competitor_intel.match_chunks(vector, integer, uuid) to authenticated, service_role;',
        'grant execute on all functions in schema pgmq_public to service_role;',
      ].sort()
    );
    expect(code).not.toMatch(/grant [^;]+ to (anon|public)\b/i);
    // storage never gains a grant here
    expect(grants.join(' ')).not.toMatch(/storage\./);
  });

  test('pgmq_public EXECUTE hardening: PUBLIC default revoked (current + future functions), service_role-only regrant', () => {
    // This wave PostgREST-exposes pgmq_public. Postgres default-grants
    // EXECUTE to PUBLIC on every function and the Wave-1 wrapper migration
    // never revoked it — leaving schema USAGE as the ONLY denial layer for
    // anon/authenticated. One upstream-documented `grant usage on schema
    // pgmq_public to authenticated` would then hand every authenticated JWT
    // SECURITY DEFINER control of EVERY pgmq queue. The migration must make
    // per-function EXECUTE a real, independent second layer.
    expect(code).toMatch(
      /revoke execute on all functions in schema pgmq_public from public, anon, authenticated;/i
    );
    expect(code).toMatch(
      /alter default privileges in schema pgmq_public revoke execute on functions from public;/i
    );
    expect(code).toMatch(
      /grant execute on all functions in schema pgmq_public to service_role;/i
    );
  });

  test('storage backstop: RLS enabled + anon deny_all on objects/buckets — ENABLE only, NEVER FORCE', () => {
    expect(code).toMatch(/alter table storage\.objects enable row level security/i);
    expect(code).toMatch(/alter table storage\.buckets enable row level security/i);
    for (const t of ['objects', 'buckets']) {
      const start = code.indexOf(`create policy ${t}_deny_all on storage.${t}`);
      expect(start).toBeGreaterThan(-1);
      const deny = code.slice(start, code.indexOf(';', start));
      expect(deny).toMatch(
        /as restrictive\s+for all\s+to anon\s+using \(false\)\s+with check \(false\)/i
      );
    }
    // FORCE on storage would subject the storage-api owner role to RLS and
    // break the storage service outright — hard negative.
    expect(code).not.toMatch(/storage\.[^;]*force row level security/i);
    // and no other storage DDL beyond the two enables + two guarded policies
    expect(code).not.toMatch(/create table[^;]*storage\./i);
    expect(code).not.toMatch(/alter table storage\.(?!objects enable|buckets enable)/i);
  });

  test('header documents apply-as, ordering AFTER w7-backups-vault, and PG 15.8', () => {
    expect(sql).toMatch(/APPLY AS supabase_admin/i);
    expect(sql).toMatch(/AFTER 2026-08-08-w7-backups-vault\.sql/i);
    expect(sql).toMatch(/15\.8/);
    expect(sql).toMatch(/safe to re-run/i);
    // filename sorts after the w7 file (apply-order is lexicographic)
    expect(
      '2026-08-08-w8-competitor-intel.sql' > '2026-08-08-w7-backups-vault.sql'
    ).toBe(true);
  });

  test('runs as ONE transaction: begin first, commit after every grant/revoke', () => {
    const statements = code
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements[0].toLowerCase()).toBe('begin');
    expect(code.match(/^\s*begin\s*;/gim)?.length).toBe(1);
    expect(code.match(/^\s*commit\s*;/gim)?.length).toBe(1);
    const commitAt = statements.findIndex((s) => s.toLowerCase() === 'commit');
    expect(commitAt).toBeGreaterThan(-1);
    for (const [i, stmt] of statements.entries()) {
      if (/^(grant|revoke)\b/i.test(stmt)) expect(i).toBeLessThan(commitAt);
    }
    // only the pgrst reload runs after the commit (w4/w5/w7 precedent)
    expect(statements.slice(commitAt + 1).map((s) => s.toLowerCase())).toEqual([
      "select pg_notify('pgrst', 'reload schema')",
    ]);
  });

  test('ends with an executable pgrst schema reload as the final line', () => {
    expect(sql).toMatch(/select pg_notify\('pgrst',\s*'reload schema'\);/i);
    const last = sql.trimEnd();
    expect(last.endsWith("select pg_notify('pgrst', 'reload schema');")).toBe(
      true
    );
  });
});

describe('declarative mirror (supabase/schemas/competitor_intel.sql)', () => {
  const declared = readRepo('supabase/schemas/competitor_intel.sql');

  test('declares the same shape the migration applies (tables, index, RPC, triggers)', () => {
    for (const t of ['sources', 'documents', 'chunks']) {
      expect(declared).toMatch(new RegExp(`create table competitor_intel\\.${t}\\b`, 'i'));
    }
    expect(declared).toMatch(/embedding\s+vector\(1024\)/i);
    expect(declared).toMatch(
      /using hnsw \(embedding vector_cosine_ops\) with \(m = 16, ef_construction = 64\)/i
    );
    expect(declared).toMatch(/function competitor_intel\.match_chunks\(/i);
    expect(declared).toMatch(/limit least\(match_count, 50\)/i);
    expect(declared).toMatch(/documents_embed_on_insert/);
    expect(declared).toMatch(/documents_embed_on_content_update/);
    expect(declared).toMatch(/documents_reset_on_content_update/);
    // shape only: the migration is the applied artifact
    expect(declared).toMatch(/NEVER apply this file to a real host/i);
  });
});

describe('PGRST_DB_SCHEMAS exposes competitor_intel + pgmq_public (Wave 8)', () => {
  test('docker-compose.override.yml: rest service serves both new schemas, bundle defaults kept', () => {
    const override = read('assets/docker-compose.override.yml');
    const line = override
      .split('\n')
      .find((l) => l.includes('PGRST_DB_SCHEMAS:'));
    expect(line).toBeDefined();
    for (const s of [
      'public',
      'storage',
      'graphql_public',
      'marketinghub',
      'competitor_intel',
      'pgmq_public',
    ]) {
      expect(line).toContain(s);
    }
  });

  test('render-env.sh keeps the .env copy in lockstep', () => {
    const renderEnv = read('assets/render-env.sh');
    expect(renderEnv).toMatch(
      /set_or_replace PGRST_DB_SCHEMAS "public,storage,graphql_public,marketinghub,competitor_intel,pgmq_public"/
    );
  });
});
