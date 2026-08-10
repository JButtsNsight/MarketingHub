import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('2026-08-10-w8-intel-fts.sql migration', () => {
  const sql = read('sql/2026-08-10-w8-intel-fts.sql');
  // Comment-stripped view of the file: the structural assertions below must
  // match executable SQL, never prose in `--` comments.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  test('fails loud unless the Wave-8 chain created the competitor_intel tables', () => {
    expect(code).toMatch(/to_regclass\('competitor_intel\.chunks'\) is null/i);
    expect(code).toMatch(/to_regclass\('competitor_intel\.documents'\) is null/i);
    expect(code).toMatch(/to_regclass\('competitor_intel\.sources'\) is null/i);
    const raises = code.match(/raise exception/gi) ?? [];
    expect(raises.length).toBe(1);
    // the operator instruction: apply the earlier chain first
    expect(code).toMatch(/apply the dated cdk\/sql chain/i);
  });

  test('is idempotent and never drops, truncates, deletes, alters or disables anything', () => {
    expect(code).toMatch(/create index if not exists chunks_content_fts_idx/i);
    expect(code).toMatch(
      /create or replace function competitor_intel\.search_chunks_fts\(/i
    );
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/drop\s+schema/i);
    expect(code).not.toMatch(/drop\s+policy/i);
    expect(code).not.toMatch(/drop\s+function/i);
    expect(code).not.toMatch(/drop\s+trigger/i);
    expect(code).not.toMatch(/drop\s+index/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/delete\s+from/i);
    expect(code).not.toMatch(/alter\s+table/i);
    expect(code).not.toMatch(/disable\s+(row level security|trigger)/i);
  });

  test('leaves the dormant pgvector pipeline untouched (parity demonstration)', () => {
    // The Wave-8 embedding path (match_chunks, HNSW, ci_embed queue,
    // triggers, sweep) stays exactly as 2026-08-08-w8-competitor-intel.sql
    // left it — this migration must not reference it at all.
    expect(code).not.toMatch(/match_chunks/i);
    expect(code).not.toMatch(/hnsw/i);
    expect(code).not.toMatch(/\bvector\b/i);
    expect(code).not.toMatch(/embedding/i);
    expect(code).not.toMatch(/pgmq/i);
    expect(code).not.toMatch(/ci_embed/i);
    expect(code).not.toMatch(/cron\./i);
    expect(code).not.toMatch(/create\s+(or replace\s+)?trigger/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/create\s+table/i);
  });

  test("FTS index: expression GIN over to_tsvector('english', content) on chunks", () => {
    const idxStart = code.indexOf(
      'create index if not exists chunks_content_fts_idx'
    );
    expect(idxStart).toBeGreaterThan(-1);
    const idx = code.slice(idxStart, code.indexOf(';', idxStart));
    expect(idx).toMatch(/on competitor_intel\.chunks/i);
    expect(idx).toMatch(/using gin \(to_tsvector\('english', content\)\)/i);
  });

  test('search_chunks_fts: FROZEN signature (query_text, match_count default 16, filter_source_id)', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/query_text text/i);
    expect(fn).toMatch(/match_count integer default 16/i);
    expect(fn).toMatch(/filter_source_id uuid default null/i);
  });

  test('search_chunks_fts: FROZEN FtsChunkRow OUT column names + types in order', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    // OUT columns must match web/src/lib/intel/schema.ts FtsChunkRow exactly
    const returns = fn.slice(fn.indexOf('returns table'), fn.indexOf('language sql'));
    const cols = [...returns.matchAll(/^\s*(\w+)\s+[\w ]+,?$/gim)].map((m) => m[1]);
    expect(cols).toEqual([
      'chunk_id',
      'document_id',
      'source_id',
      'seq',
      'content',
      'rank',
      'document_title',
      'source_name',
    ]);
    expect(returns).toMatch(/chunk_id\s+bigint/i);
    expect(returns).toMatch(/document_id\s+uuid/i);
    expect(returns).toMatch(/source_id\s+uuid/i);
    expect(returns).toMatch(/seq\s+integer/i);
    expect(returns).toMatch(/content\s+text/i);
    expect(returns).toMatch(/rank\s+double precision/i);
    expect(returns).toMatch(/document_title\s+text/i);
    expect(returns).toMatch(/source_name\s+text/i);
  });

  test('search_chunks_fts: sql STABLE SECURITY INVOKER (RLS stays in force)', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/language sql\s+stable\s+security invoker/i);
    expect(fn).not.toMatch(/security definer/i);
  });

  test('WHERE clause textually matches the index expression (GIN stays usable)', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    // Must be to_tsvector('english', c.content) — same expression and same
    // regconfig as the index — matched against websearch_to_tsquery.
    expect(fn).toMatch(
      /where to_tsvector\('english', c\.content\) @@ websearch_to_tsquery\('english', query_text\)/i
    );
    // no config-less to_tsvector/websearch_to_tsquery anywhere in the file:
    // a bare call binds the session default_text_search_config and would
    // silently bypass the 'english' expression index.
    expect(code).not.toMatch(/to_tsvector\((?!'english')/i);
    expect(code).not.toMatch(/websearch_to_tsquery\((?!'english')/i);
  });

  test('rank: ts_rank_cd over the same expression, cast to double precision', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(
      /ts_rank_cd\(\s*to_tsvector\('english', c\.content\),\s*websearch_to_tsquery\('english', query_text\)\s*\)::double precision as rank/i
    );
  });

  test('joins chunks → documents → sources and honors the source filter', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/from competitor_intel\.chunks c/i);
    expect(fn).toMatch(/join competitor_intel\.documents d on d\.id = c\.document_id/i);
    expect(fn).toMatch(/join competitor_intel\.sources s on s\.id = d\.source_id/i);
    expect(fn).toMatch(
      /filter_source_id is null or d\.source_id = filter_source_id/i
    );
    expect(fn).toMatch(/d\.title\s+as document_title/i);
    expect(fn).toMatch(/s\.name\s+as source_name/i);
  });

  test('deterministic order + server-side clamp: rank desc then c.id, LIMIT 1..50', () => {
    const fnStart = code.indexOf(
      'create or replace function competitor_intel.search_chunks_fts('
    );
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/order by rank desc, c\.id/i);
    expect(fn).toMatch(/limit least\(greatest\(match_count, 1\), 50\)/i);
  });

  test('grant matrix: revoke-then-grant mirrors match_chunks, nothing to anon/public', () => {
    expect(code).toMatch(
      /revoke all on function competitor_intel\.search_chunks_fts\(text, integer, uuid\) from anon, authenticated, public/i
    );
    // enumerate EVERY grant in the file — nothing extra may sneak in.
    const grants = (code.match(/grant [^;]+;/gi) ?? []).map((g) =>
      g.replace(/\s+/g, ' ').toLowerCase()
    );
    expect(grants).toEqual([
      'grant execute on function competitor_intel.search_chunks_fts(text, integer, uuid) to authenticated, service_role;',
    ]);
    expect(code).not.toMatch(/grant [^;]+ to (anon|public)\b/i);
  });

  test('header documents apply-as, ordering AFTER w8-competitor-intel, and PG 15.8', () => {
    expect(sql).toMatch(/APPLY AS supabase_admin/i);
    expect(sql).toMatch(/AFTER 2026-08-08-w8-competitor-intel\.sql/i);
    expect(sql).toMatch(/15\.8/);
    expect(sql).toMatch(/safe to re-run/i);
    // filename sorts after the w8 file (apply-order is lexicographic)
    expect(
      '2026-08-10-w8-intel-fts.sql' > '2026-08-08-w8-competitor-intel.sql'
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
    // only the pgrst reload runs after the commit (w4/w5/w7/w8 precedent)
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
