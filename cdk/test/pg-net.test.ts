import * as fs from 'fs';
import * as path from 'path';

test('lockdown-pg-net.sql revokes EXECUTE from anon/authenticated/PUBLIC', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'lockdown-pg-net.sql'), 'utf8');
  expect(sql).toMatch(/REVOKE\s+EXECUTE/i);
  expect(sql).toMatch(/net\.http_get/i);
  expect(sql).toMatch(/net\.http_post/i);
  expect(sql).toMatch(/\bPUBLIC\b/);
  expect(sql).toMatch(/\banon\b/);
  expect(sql).toMatch(/\bauthenticated\b/);
});
