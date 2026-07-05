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
  // shellcheck if available; skip cleanly if not installed
  try {
    execSync(`shellcheck ${path.join(root, 'scripts/rls-gate.sh')}`);
  } catch (e: any) {
    if (!/not found|ENOENT/i.test(String(e.stderr ?? e.message))) throw e;
  }
});
