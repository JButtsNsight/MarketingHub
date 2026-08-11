import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// The two tables gaining nullable write-back columns — all pre-existing, so
// this migration is purely additive alter-table statements plus the standard
// privilege/RLS re-asserts.
const TABLES = ['contact_lists', 'sms_campaign_recipients'];

describe('2026-08-11-monday-writeback.sql migration', () => {
  const sql = read('sql/2026-08-11-monday-writeback.sql');

  test('adds every write-back column additively (add column if not exists)', () => {
    expect(sql).toMatch(
      /alter table marketinghub\.contact_lists\s+add column if not exists monday_outcome_column_id text/i
    );
    expect(sql).toMatch(
      /alter table marketinghub\.sms_campaign_recipients\s+add column if not exists monday_synced_at timestamptz/i
    );
    expect(sql).toMatch(
      /alter table marketinghub\.sms_campaign_recipients\s+add column if not exists monday_synced_status text/i
    );
  });

  test('all columns are nullable (no NOT NULL — CSV campaigns are never synced)', () => {
    expect(sql).not.toMatch(/not\s+null/i);
  });

  test('is never destructive of data (the only DROP is the w5 trigger swap)', () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
    expect(sql).not.toMatch(/drop\s+view/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/drop\s+constraint/i);
    // Exactly ONE drop trigger — the w5 recipients trigger being split.
    const dropTriggers = sql.match(/drop\s+trigger/gi) ?? [];
    expect(dropTriggers).toHaveLength(1);
    expect(sql).toMatch(
      /drop trigger if exists sms_campaign_recipients_mh_notify\s+on marketinghub\.sms_campaign_recipients/i
    );
  });

  test('splits the w5 recipients trigger: INSERT unconditional, UPDATE filtered past the watermark columns', () => {
    expect(sql).toMatch(
      /create trigger sms_campaign_recipients_mh_notify_ins\s+after insert on marketinghub\.sms_campaign_recipients/i
    );
    expect(sql).toMatch(
      /create trigger sms_campaign_recipients_mh_notify_upd\s+after update on marketinghub\.sms_campaign_recipients/i
    );
    // The UPDATE trigger's WHEN must ignore ONLY the two watermark columns.
    expect(sql).toMatch(
      /\(to_jsonb\(old\) - 'monday_synced_at' - 'monday_synced_status'\)\s+is distinct from\s+\(to_jsonb\(new\) - 'monday_synced_at' - 'monday_synced_status'\)/i
    );
    // Both halves keep broadcasting to the same topic argument.
    const notifyCalls =
      sql.match(/execute function marketinghub\.tg_mh_notify\('campaigns'\)/gi) ?? [];
    expect(notifyCalls).toHaveLength(2);
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
