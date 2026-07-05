import * as fs from 'fs';
import * as path from 'path';

test('enable-pgaudit.sql enables the extension and logs DML with role attribution', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'enable-pgaudit.sql'), 'utf8');
  expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgaudit/i);
  expect(sql).toMatch(/pgaudit\.log/i);
  expect(sql).toMatch(/write/i);           // DML classes
  expect(sql).toMatch(/ALTER ROLE/i);      // role-attributed logging
});
