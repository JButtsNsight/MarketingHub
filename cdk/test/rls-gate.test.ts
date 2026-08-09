import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('rls-gate.sql selects offending tables from pg_tables/pg_policies', () => {
  const sql = read('sql/rls-gate.sql');
  expect(sql).toMatch(/pg_tables/);
  expect(sql).toMatch(/pg_policies/);
  expect(sql).toMatch(/rowsecurity\s*=\s*false/i);
  // exposed schemas covered
  expect(sql).toMatch(/'public'/);
  expect(sql).toMatch(/'storage'/);
  expect(sql).toMatch(/'auth'/);
  expect(sql).toMatch(/'realtime'/);
  // both app schemas are exposed to PostgREST (PGRST_DB_SCHEMAS) → the gate
  // must cover them
  expect(sql).toMatch(/'marketinghub'/);
  expect(sql).toMatch(/'competitor_intel'/);
});

test('rls-gate.sql (Wave 4/8): app-schema arm demands FORCE RLS + a restrictive anon policy', () => {
  const sql = read('sql/rls-gate.sql');
  // Permissive `authenticated` policies exist now, so a bare policy count no
  // longer proves deny-by-default for the app schemas — the gate must also
  // flag: FORCE RLS off (owner bypass) ...
  expect(sql).toMatch(/relforcerowsecurity/);
  expect(sql).toMatch(/RLS_NOT_FORCED/);
  // ... and a missing RESTRICTIVE deny-all that applies to anon (a policy
  // TO public applies to anon too, so it also satisfies the gate).
  expect(sql).toMatch(/permissive\s*=\s*'RESTRICTIVE'/i);
  expect(sql).toMatch(/'anon'\s*=\s*ANY\s*\(\s*p\.roles\s*\)/i);
  expect(sql).toMatch(/'public'\s*=\s*ANY\s*\(\s*p\.roles\s*\)/i);
  expect(sql).toMatch(/NO_RESTRICTIVE_ANON_POLICY/);
  // both arms feed one zero-rows-pass result set
  expect(sql).toMatch(/UNION ALL/i);
  // Wave 8: BOTH app schemas drive arm 2 through one CTE
  expect(sql).toMatch(
    /app_schemas\(schemaname\) AS \(\s*VALUES \('marketinghub'\), \('competitor_intel'\)\s*\)/i
  );
  // Arm 2 must cover partitioned parents too ('p'): pg_tables (arm 1's
  // source) includes them, so relkind = 'r' alone would let a partitioned
  // app table skip the FORCE-RLS / anon-deny checks entirely.
  expect(sql).toMatch(/c\.relkind IN \('r', 'p'\)/i);
  expect(sql).not.toMatch(/c\.relkind = 'r'/i);
});

describe('rls-gate.sql Wave-8 scoping: documented bundle allowlist', () => {
  const sql = read('sql/rls-gate.sql');
  // the executable allowlist CTE only (not the prose header)
  const start = sql.indexOf('bundle_allowlist(schemaname, tablename_like)');
  const end = sql.indexOf('app_schemas(schemaname)');
  const allowlist = sql.slice(start, end);

  test('the allowlist CTE exists and gates via NOT EXISTS + LIKE', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM bundle_allowlist b/i);
    expect(sql).toMatch(/e\.tablename LIKE b\.tablename_like/i);
  });

  test('allowlists ONLY the documented bundle-managed internals', () => {
    // GoTrue owns the whole auth schema
    expect(allowlist).toMatch(/\('auth',\s*'%'\)/);
    // storage-api internals (live posture) — escaped underscores so a
    // lookalike name cannot ride a pattern
    expect(allowlist).toMatch(/\('storage',\s*'migrations'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'prefixes'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'s3\\_multipart\\_uploads'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'s3\\_multipart\\_uploads\\_parts'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'buckets\\_analytics'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'vector\\_indexes'\)/);
    expect(allowlist).toMatch(/\('storage',\s*'iceberg\\_%'\)/);
    // realtime internals: partitions + subscription + migration ledger
    expect(allowlist).toMatch(/\('realtime',\s*'messages\\_%'\)/);
    expect(allowlist).toMatch(/\('realtime',\s*'subscription'\)/);
    expect(allowlist).toMatch(/\('realtime',\s*'schema\\_migrations'\)/);
    // wrappers extension stats table
    expect(allowlist).toMatch(/\('public',\s*'wrappers\\_fdw\\_stats'\)/);
  });

  test('NEVER allowlists an app schema', () => {
    expect(allowlist).not.toMatch(/marketinghub/);
    expect(allowlist).not.toMatch(/competitor_intel/);
  });

  test('NEVER allowlists storage.objects / storage.buckets (our data — gated on real posture)', () => {
    expect(allowlist).not.toMatch(/\('storage',\s*'objects'\)/);
    expect(allowlist).not.toMatch(/\('storage',\s*'buckets'\)/);
    // no wildcard row that could swallow them either
    expect(allowlist).not.toMatch(/\('storage',\s*'%'\)/);
    expect(allowlist).not.toMatch(/\('storage',\s*'o[%_]/);
    expect(allowlist).not.toMatch(/\('storage',\s*'buckets[%]'\)/);
  });

  test('realtime.messages PARENT stays gated (w5-realtime.test.ts asserts its policies)', () => {
    // only the daily partitions (messages\_%) are allowlisted — never a bare
    // 'messages' row and never a pattern that matches the parent
    expect(allowlist).not.toMatch(/\('realtime',\s*'messages'\)/);
    expect(allowlist).not.toMatch(/\('realtime',\s*'%'\)/);
    // ('realtime', 'messages\_%') requires at least one char after the
    // escaped underscore, so the parent 'messages' can never match it
    expect(allowlist).toMatch(/\('realtime',\s*'messages\\_%'\)/);
  });

  test('app schemas are STRUCTURALLY exempt from the allowlist (tripwire holds)', () => {
    // Even if a future edit sneaks an app-schema row into the allowlist, the
    // gated CTE re-includes app schemas ahead of the NOT EXISTS check — a
    // policy-less new table in marketinghub or competitor_intel always trips
    // (verified live against an ephemeral supabase/postgres:15.8.1.085:
    // chain+W8 ⇒ ZERO rows; a bare table in either app schema ⇒ rows for
    // exactly that table, RLS_DISABLED + RLS_NOT_FORCED).
    expect(read('sql/rls-gate.sql')).toMatch(
      /WHERE e\.schemaname IN \(SELECT a\.schemaname FROM app_schemas a\)\s*OR NOT EXISTS/i
    );
  });
});

test('enable-rls-template.sql shows ENABLE + FORCE + deny-by-default + REVOKE/GRANT', () => {
  const sql = read('sql/enable-rls-template.sql');
  expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
  expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
  expect(sql).toMatch(/CREATE POLICY/i);
  expect(sql).toMatch(/USING\s*\(\s*false\s*\)/i); // deny-by-default example
  expect(sql).toMatch(/REVOKE/i);
  expect(sql).toMatch(/GRANT/i);
});

test('rls-gate.sh is valid bash and exits non-zero on offending tables', () => {
  // static checks only (no live DB in CI)
  execSync(`bash -n ${path.join(root, 'scripts/rls-gate.sh')}`);
  const sh = read('scripts/rls-gate.sh');
  expect(sh).toMatch(/psql/);
  expect(sh).toMatch(/rls-gate\.sql/);
  expect(sh).toMatch(/exit\s+1/);
  // the operator-facing wording explains the Wave-8 scoping honestly
  expect(sh).toMatch(/allowlist/i);
  // shellcheck if available; skip cleanly if not installed
  try {
    execSync(`shellcheck ${path.join(root, 'scripts/rls-gate.sh')}`);
  } catch (e: any) {
    if (!/not found|ENOENT/i.test(String(e.stderr ?? e.message))) throw e;
  }
});
