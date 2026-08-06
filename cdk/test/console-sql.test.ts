import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const TABLES = ['console_snippets', 'console_query_history'];

describe('2026-08-06-console-sql.sql migration', () => {
  const sql = read('sql/2026-08-06-console-sql.sql');

  test('is idempotent (create ... if not exists) and never drops anything', () => {
    expect(sql).toMatch(/create schema if not exists marketinghub/i);
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(`create table if not exists marketinghub\\.${table}\\b`, 'i')
      );
    }
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
  });

  test('history table captures the audit fields for the superuser query surface', () => {
    for (const col of ['sql', 'ran_by', 'ran_at', 'duration_ms', 'row_count', 'error']) {
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`, 'i'));
    }
    expect(sql).toMatch(/console_query_history_ran_at_idx/i);
  });

  test('every new table gets ENABLE + FORCE + a deny-all restrictive policy', () => {
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(`alter table marketinghub\\.${table} enable row level security`, 'i')
      );
      expect(sql).toMatch(
        new RegExp(`alter table marketinghub\\.${table} force row level security`, 'i')
      );
      expect(sql).toMatch(new RegExp(`create policy ${table}_deny_all`, 'i'));
    }
  });

  test('re-asserts service_role privileges and reminds about the pgrst reload', () => {
    expect(sql).toMatch(/grant usage on schema marketinghub to service_role/i);
    expect(sql).toMatch(
      /grant all privileges on all tables in schema marketinghub to service_role/i
    );
    expect(sql).toMatch(/pg_notify\('pgrst',\s*'reload schema'\)/i);
  });
});
