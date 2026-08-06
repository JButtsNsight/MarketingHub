import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// The four new engagement tables — idempotent and RLS-locked like every
// marketinghub table.
const TABLES = [
  'sms_links',
  'sms_link_clicks',
  'sms_inbound_messages',
  'sms_suppression_audit',
];

describe('2026-08-05-engagement-suite.sql migration', () => {
  const sql = read('sql/2026-08-05-engagement-suite.sql');

  test('is idempotent (create ... if not exists) and never drops data objects', () => {
    expect(sql).toMatch(/create schema if not exists marketinghub/i);
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(`create table if not exists marketinghub\\.${table}\\b`, 'i')
      );
    }
    // never destructive to data — the only allowed DROPs are the constraint
    // widenings and the RPC redefinition, each re-created in the same file.
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
    expect(sql).not.toMatch(/drop\s+view/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
    expect(sql).not.toMatch(/drop\s+column/i);
  });

  test('widens the recipient status machine with frequency_capped (superset)', () => {
    expect(sql).toMatch(
      /drop constraint if exists sms_campaign_recipients_status_check/i
    );
    expect(sql).toMatch(
      /check\s*\(\s*status\s+in\s*\(\s*'pending'\s*,\s*'claimed'\s*,\s*'sending'\s*,\s*'sent'\s*,\s*'delivered'\s*,\s*'undelivered'\s*,\s*'failed'\s*,\s*'failed_ambiguous'\s*,\s*'suppressed'\s*,\s*'skipped'\s*,\s*'canceled'\s*,\s*'frequency_capped'\s*\)\s*\)/i
    );
  });

  test('widens webhook-event kinds with inbound (superset)', () => {
    expect(sql).toMatch(
      /drop constraint if exists sms_webhook_events_kind_check/i
    );
    expect(sql).toMatch(
      /check\s*\(\s*kind\s+in\s*\(\s*'unsubscribe'\s*,\s*'delivery_report'\s*,\s*'inbound'\s*,\s*'unknown'\s*\)\s*\)/i
    );
  });

  test('replaces the claim RPC: old overloads dropped, 4-arg created with defaults', () => {
    // Both signatures dropped BEFORE create — coexisting overloads would make
    // PostgREST named-arg resolution ambiguous.
    expect(sql).toMatch(
      /drop function if exists marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*\)/i
    );
    expect(sql).toMatch(
      /drop function if exists marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*,\s*int\s*,\s*int\s*\)/i
    );
    expect(sql).toMatch(
      /create function marketinghub\.claim_due_sms_recipients\s*\(\s*batch_size\s+int\s+default\s+25\s*,\s*claim_ttl_seconds\s+int\s+default\s+180\s*,\s*freq_cap_count\s+int\s+default\s+0\s*,\s*freq_cap_days\s+int\s+default\s+0\s*\)/i
    );
    // Cap disabled by default: the sweep only runs when both params are > 0.
    expect(sql).toMatch(
      /if\s+freq_cap_count\s*>\s*0\s+and\s+freq_cap_days\s*>\s*0\s+then/i
    );
    expect(sql).toMatch(/'frequency_capped'/);
  });

  test('RPC privileges: revoke from public/anon/authenticated, grant to service_role', () => {
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*,\s*int\s*,\s*int\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i
    );
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*,\s*int\s*,\s*int\s*\)\s+to\s+service_role/i
    );
  });

  test('engagement view is security_invoker (RLS must not leak through)', () => {
    expect(sql).toMatch(
      /create or replace view marketinghub\.sms_campaign_engagement\s+with\s*\(\s*security_invoker\s*=\s*true\s*\)/i
    );
  });

  test('consent provenance columns are additive if-not-exists', () => {
    expect(sql).toMatch(/add column if not exists consent_source text/i);
    expect(sql).toMatch(/add column if not exists consent_date text/i);
  });

  test('every new table gets ENABLE + FORCE + a deny-all restrictive policy', () => {
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
