import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// The four outbox tables — every one must be idempotent and RLS-locked.
const TABLES = [
  'sms_campaigns',
  'sms_campaign_recipients',
  'sms_suppressions',
  'sms_webhook_events',
];

describe('2026-07-22-sms-campaigns.sql migration', () => {
  const sql = read('sql/2026-07-22-sms-campaigns.sql');

  test('is idempotent (create ... if not exists) and never drops anything', () => {
    expect(sql).toMatch(/create schema if not exists marketinghub/i);
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(`create table if not exists marketinghub\\.${table}\\b`, 'i')
      );
    }
    // never destructive
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+schema/i);
    expect(sql).not.toMatch(/drop\s+view/i);
    expect(sql).not.toMatch(/drop\s+function/i);
    expect(sql).not.toMatch(/drop\s+policy/i);
  });

  test('constrains campaign status to the exact campaign state machine', () => {
    expect(sql).toMatch(
      /check\s*\(\s*status\s+in\s*\(\s*'scheduled'\s*,\s*'sending'\s*,\s*'paused'\s*,\s*'completed'\s*,\s*'canceled'\s*\)\s*\)/i
    );
  });

  test('constrains recipient status to the exact recipient state machine', () => {
    expect(sql).toMatch(
      /check\s*\(\s*status\s+in\s*\(\s*'pending'\s*,\s*'claimed'\s*,\s*'sending'\s*,\s*'sent'\s*,\s*'delivered'\s*,\s*'undelivered'\s*,\s*'failed'\s*,\s*'failed_ambiguous'\s*,\s*'suppressed'\s*,\s*'skipped'\s*,\s*'canceled'\s*\)\s*\)/i
    );
  });

  test('constrains suppression reason and webhook-event kind', () => {
    expect(sql).toMatch(
      /check\s*\(\s*reason\s+in\s*\(\s*'stop'\s*,\s*'manual'\s*\)\s*\)/i
    );
    expect(sql).toMatch(
      /check\s*\(\s*kind\s+in\s*\(\s*'unsubscribe'\s*,\s*'delivery_report'\s*,\s*'unknown'\s*\)\s*\)/i
    );
  });

  test('deduplicates recipients per campaign via unique (campaign_id, phone_e164)', () => {
    // Duplicate rows marked `skipped` must carry phone_e164 = null (nulls are
    // distinct) or the second insert for a phone would violate this.
    expect(sql).toMatch(/unique\s*\(\s*campaign_id\s*,\s*phone_e164\s*\)/i);
  });

  test('indexes the campaign promotion query on (status, send_at)', () => {
    expect(sql).toMatch(
      /create index if not exists sms_campaigns_status_send_at_idx\s+on marketinghub\.sms_campaigns\s*\(\s*status\s*,\s*send_at\s*\)/i
    );
  });

  test('creates the partial outbox indexes for due-pending rows and expiring claims', () => {
    expect(sql).toMatch(
      /create index if not exists sms_campaign_recipients_due_idx\s+on marketinghub\.sms_campaign_recipients\s*\(\s*send_after\s*\)\s+where status\s*=\s*'pending'/i
    );
    expect(sql).toMatch(
      /create index if not exists sms_campaign_recipients_expiry_idx\s+on marketinghub\.sms_campaign_recipients\s*\(\s*claim_expires_at\s*\)\s+where status in\s*\(\s*'claimed'\s*,\s*'sending'\s*\)/i
    );
  });

  test('creates lookup indexes on campaign_id, st_message_id and phone_e164', () => {
    expect(sql).toMatch(
      /create index if not exists sms_campaign_recipients_campaign_id_idx\s+on marketinghub\.sms_campaign_recipients\s*\(\s*campaign_id\s*\)/i
    );
    expect(sql).toMatch(
      /create index if not exists sms_campaign_recipients_st_message_id_idx\s+on marketinghub\.sms_campaign_recipients\s*\(\s*st_message_id\s*\)/i
    );
    expect(sql).toMatch(
      /create index if not exists sms_campaign_recipients_phone_e164_idx\s+on marketinghub\.sms_campaign_recipients\s*\(\s*phone_e164\s*\)/i
    );
  });

  test('exposes per-campaign status counts through a security_invoker view', () => {
    // security_invoker = true keeps the deny-all RLS of the underlying table
    // in effect for anon/authenticated querying the view.
    expect(sql).toMatch(
      /create or replace view marketinghub\.sms_campaign_recipient_counts/i
    );
    expect(sql).toMatch(/security_invoker\s*=\s*true/i);
    expect(sql).toMatch(/group by\s+campaign_id\s*,\s*status/i);
  });

  test('claim RPC claims due rows with FOR UPDATE ... SKIP LOCKED from sending campaigns only', () => {
    expect(sql).toMatch(
      /create or replace function marketinghub\.claim_due_sms_recipients\s*\(\s*batch_size\s+int\s+default\s+25\s*,\s*claim_ttl_seconds\s+int\s+default\s+180\s*\)/i
    );
    expect(sql).toMatch(/returns setof marketinghub\.sms_campaign_recipients/i);
    expect(sql).toMatch(/language plpgsql/i);
    expect(sql).toMatch(/security invoker/i);
    // Only campaigns actively dispatching yield claims...
    expect(sql).toMatch(/c\.status\s*=\s*'sending'/i);
    // ...oldest due first, bounded batch, concurrency-safe.
    expect(sql).toMatch(/order by\s+r\.send_after/i);
    expect(sql).toMatch(/limit\s+batch_size/i);
    expect(sql).toMatch(/for update of r skip locked/i);
  });

  test('claim RPC recovers crashed rows: suppression sweep, expired claimed -> pending, expired sending -> failed_ambiguous', () => {
    // (1) due pending rows whose phone joined the STOP list -> suppressed
    expect(sql).toMatch(
      /set\s+status\s*=\s*'suppressed'[\s\S]*?where\s+r\.status\s*=\s*'pending'[\s\S]*?sms_suppressions/i
    );
    // (2) expired claimed rows (no POST started) safely return to pending
    expect(sql).toMatch(
      /set\s+status\s*=\s*'pending'[\s\S]*?where\s+r\.status\s*=\s*'claimed'\s+and\s+r\.claim_expires_at\s*<=\s*now\(\)/i
    );
    // (3) expired sending rows (POST may have landed) are NEVER auto-retried
    expect(sql).toMatch(
      /set\s+status\s*=\s*'failed_ambiguous'[\s\S]*?where\s+r\.status\s*=\s*'sending'\s+and\s+r\.claim_expires_at\s*<=\s*now\(\)/i
    );
  });

  test('claim RPC EXECUTE is granted to service_role and revoked from public/anon/authenticated', () => {
    // Postgres grants EXECUTE on new functions to PUBLIC by default — the
    // revoke is load-bearing, not belt-and-suspenders.
    expect(sql).toMatch(
      /grant\s+execute\s+on\s+function\s+marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*\)\s+to\s+service_role/i
    );
    expect(sql).toMatch(
      /revoke\s+execute\s+on\s+function\s+marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i
    );
  });

  test('grants schema + table privileges to service_role (the sole app role)', () => {
    expect(sql).toMatch(/grant\s+usage\s+on\s+schema\s+marketinghub\s+to\s+service_role/i);
    expect(sql).toMatch(
      /grant\s+all(\s+privileges)?\s+on\s+all\s+tables\s+in\s+schema\s+marketinghub\s+to\s+service_role/i
    );
    expect(sql).toMatch(
      /alter\s+default\s+privileges\s+in\s+schema\s+marketinghub[\s\S]*grant\s+all(\s+privileges)?\s+on\s+tables\s+to\s+service_role/i
    );
  });

  test('enables deny-by-default RLS on every table (ENABLE + FORCE + restrictive deny-all policy)', () => {
    for (const table of TABLES) {
      expect(sql).toMatch(
        new RegExp(`alter\\s+table\\s+marketinghub\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i')
      );
      expect(sql).toMatch(
        new RegExp(`alter\\s+table\\s+marketinghub\\.${table}\\s+force\\s+row\\s+level\\s+security`, 'i')
      );
      // do-block-guarded (DROP-free, idempotent) policy creation
      expect(sql).toMatch(
        new RegExp(`policyname\\s*=\\s*'${table}_deny_all'`, 'i')
      );
      expect(sql).toMatch(
        new RegExp(
          `create\\s+policy\\s+${table}_deny_all\\s+on\\s+marketinghub\\.${table}\\s+` +
            `as\\s+restrictive\\s+for\\s+all\\s+to\\s+anon\\s*,\\s*authenticated\\s+` +
            `using\\s*\\(\\s*false\\s*\\)\\s+with\\s+check\\s*\\(\\s*false\\s*\\)`,
          'i'
        )
      );
    }
  });

  test('documents the PostgREST schema-cache reload (pg_notify) after apply', () => {
    // New tables/RPC 404 on PostgREST until the schema cache reloads.
    expect(sql).toMatch(/pg_notify\s*\(\s*'pgrst'\s*,\s*'reload schema'\s*\)/i);
  });
});
