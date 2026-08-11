import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// The three tables gaining nullable timezone columns — all pre-existing, so
// this migration is purely additive alter-table statements plus the standard
// privilege/RLS re-asserts.
const TABLES = [
  'contact_list_members',
  'contact_lists',
  'sms_campaign_recipients',
];

describe('2026-08-11-recipient-timezones.sql migration', () => {
  const sql = read('sql/2026-08-11-recipient-timezones.sql');

  test('adds every timezone column additively (add column if not exists)', () => {
    expect(sql).toMatch(
      /alter table marketinghub\.contact_list_members\s+add column if not exists timezone text/i
    );
    expect(sql).toMatch(
      /alter table marketinghub\.contact_lists\s+add column if not exists monday_timezone_column_id text/i
    );
    expect(sql).toMatch(
      /alter table marketinghub\.sms_campaign_recipients\s+add column if not exists send_timezone text/i
    );
  });

  test('all columns are nullable (no NOT NULL — null means campaign-zone fallback)', () => {
    expect(sql).not.toMatch(/not\s+null/i);
  });

  test('send_timezone gains a named, guarded CHECK to the closed send-zone set (null allowed)', () => {
    expect(sql).toMatch(
      /add constraint sms_campaign_recipients_send_timezone_check/i
    );
    expect(sql).toMatch(/send_timezone is null or send_timezone in/i);
    // Guarded on pg_constraint so re-runs are no-ops.
    expect(sql).toMatch(
      /conname\s*=\s*'sms_campaign_recipients_send_timezone_check'/i
    );
    for (const zone of [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Pacific/Honolulu',
    ]) {
      expect(sql).toContain(`'${zone}'`);
    }
  });

  test('zone-counts view aggregates SQL-side, security_invoker, authenticated-select only', () => {
    expect(sql).toMatch(
      /create or replace view marketinghub\.sms_campaign_recipient_zone_counts\s+with \(security_invoker = true\)/i
    );
    expect(sql).toMatch(
      /select campaign_id, send_timezone, count\(\*\)::int as count/i
    );
    expect(sql).toMatch(
      /revoke all on marketinghub\.sms_campaign_recipient_zone_counts\s+from anon, authenticated, public/i
    );
    expect(sql).toMatch(
      /grant select on marketinghub\.sms_campaign_recipient_zone_counts\s+to authenticated/i
    );
  });

  test('is never destructive (no DROPs of any kind)', () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
    expect(sql).not.toMatch(/drop\s+view/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/drop\s+constraint/i);
  });

  test('never touches the claim RPC (engagement-suite owns it, applied LAST)', () => {
    expect(sql).not.toMatch(/claim_due_sms_recipients/i);
  });

  test('every touched table re-asserts ENABLE + FORCE + a deny-all restrictive policy', () => {
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(
          `alter table marketinghub\\.${table} enable row level security`,
          'i'
        )
      );
      expect(sql).toMatch(
        new RegExp(
          `alter table marketinghub\\.${table} force row level security`,
          'i'
        )
      );
      expect(sql).toMatch(
        new RegExp(`create policy ${table}_deny_all`, 'i')
      );
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
