import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..'); // repo root from cdk/test
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('restore-drill runbook covers WAL replay, row counts, storage round-trip, RTO, quarterly', () => {
  const md = read('docs/runbooks/restore-drill.md');
  expect(md).toMatch(/WAL replay/i);
  expect(md).toMatch(/row count/i);
  expect(md).toMatch(/Storage object round-trip/i);
  expect(md).toMatch(/RTO/);
  expect(md).toMatch(/quarterly/i);
});

test('upgrade runbook covers backup-first, drop slots, pg_upgrade, extensions, rollback', () => {
  const md = read('docs/runbooks/upgrade-postgres-major.md');
  expect(md).toMatch(/backup/i);
  expect(md).toMatch(/replication slot/i);
  expect(md).toMatch(/pg_upgrade/i);
  expect(md).toMatch(/extension/i);
  expect(md).toMatch(/rollback/i);
});
