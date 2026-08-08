import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// The Wave-4 policy matrix — the EXACT ops role `authenticated` gets, per
// table (policy AND grant). Everything else stays denied.
const MATRIX: Record<string, string[]> = {
  templates: ['select', 'insert', 'update'],
  contact_lists: ['select', 'insert', 'update', 'delete'],
  contact_list_members: ['select', 'insert'],
  sms_campaigns: ['select', 'insert', 'update'],
  sms_campaign_recipients: ['select', 'insert', 'update'],
  sms_suppressions: ['select', 'insert', 'delete'],
  sms_suppression_audit: ['insert'],
  sms_links: ['select', 'insert'],
  sms_link_clicks: ['select'],
  sms_inbound_messages: ['select', 'update'],
};

// Service-only tables: NO authenticated policies, NO authenticated grants,
// deny_all (anon, authenticated) untouched.
const SERVICE_ONLY = [
  'sms_webhook_events',
  'console_snippets',
  'console_query_history',
  'console_impersonation_audit',
];

const USER_TABLES = Object.keys(MATRIX);
const ALL_TABLES = [...USER_TABLES, ...SERVICE_ONLY]; // all 14 marketinghub tables
const ALL_OPS = ['select', 'insert', 'update', 'delete'];
const VIEWS = ['sms_campaign_recipient_counts', 'sms_campaign_engagement'];

describe('2026-08-08-w4-user-rls.sql migration', () => {
  const sql = read('sql/2026-08-08-w4-user-rls.sql');
  // Comment-stripped view of the file: the structural assertions below must
  // match executable SQL, never prose in `--` comments.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  test('every marketinghub table is covered (14 tables + both views)', () => {
    for (const table of ALL_TABLES) {
      expect(code).toMatch(new RegExp(`marketinghub\\.${table}\\b`, 'i'));
    }
    for (const view of VIEWS) {
      expect(code).toMatch(new RegExp(`marketinghub\\.${view}\\b`, 'i'));
    }
  });

  test('is idempotent and never drops data objects', () => {
    expect(code).toMatch(/create schema if not exists marketinghub/i);
    expect(code).toMatch(
      /create table if not exists marketinghub\.console_impersonation_audit\b/i
    );
    expect(code).toMatch(
      /create or replace function marketinghub\.custom_access_token_hook/i
    );
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/drop\s+schema/i);
    expect(code).not.toMatch(/drop\s+view/i);
    expect(code).not.toMatch(/drop\s+policy/i);
    expect(code).not.toMatch(/drop\s+column/i);
    expect(code).not.toMatch(/drop\s+function/i);
  });

  test('every CREATE POLICY sits behind a pg_policies if-not-exists guard', () => {
    const creates = code.match(/create policy/gi) ?? [];
    const guards =
      code.match(/if not exists\s*\(\s*select 1 from pg_policies/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guards.length).toBe(creates.length);
  });

  test('policy matrix is EXACT: permitted ops present, everything else absent', () => {
    for (const table of USER_TABLES) {
      for (const op of ALL_OPS) {
        const policy = new RegExp(
          `create policy ${table}_authenticated_${op} on marketinghub\\.${table}\\b`,
          'i'
        );
        if (MATRIX[table].includes(op)) {
          expect(code).toMatch(policy);
        } else {
          expect(code).not.toMatch(
            new RegExp(`${table}_authenticated_${op}`, 'i')
          );
        }
      }
    }
  });

  test('no authenticated policy of ANY kind on service-only tables', () => {
    for (const table of SERVICE_ONLY) {
      expect(code).not.toMatch(new RegExp(`${table}_authenticated_`, 'i'));
      // no permissive policy naming these tables at all (only the deny_all
      // do-block for the new audit table)
      expect(code).not.toMatch(
        new RegExp(`create policy ${table}_(select|insert|update|delete)`, 'i')
      );
    }
  });

  test('policies use the correct clause per command (USING vs WITH CHECK)', () => {
    // SELECT/DELETE: USING(true), no WITH CHECK. INSERT: WITH CHECK(true),
    // no USING. UPDATE: both.
    for (const table of USER_TABLES) {
      for (const op of MATRIX[table]) {
        const start = code.indexOf(`create policy ${table}_authenticated_${op}`);
        expect(start).toBeGreaterThan(-1);
        const stmt = code.slice(start, code.indexOf(';', start));
        expect(stmt).toMatch(new RegExp(`for ${op} to authenticated`, 'i'));
        if (op === 'select' || op === 'delete') {
          expect(stmt).toMatch(/using\s*\(\s*true\s*\)/i);
          expect(stmt).not.toMatch(/with check/i);
        } else if (op === 'insert') {
          expect(stmt).toMatch(/with check\s*\(\s*true\s*\)/i);
          expect(stmt).not.toMatch(/using/i);
        } else {
          expect(stmt).toMatch(/using\s*\(\s*true\s*\)/i);
          expect(stmt).toMatch(/with check\s*\(\s*true\s*\)/i);
        }
      }
    }
  });

  test('deny-all surgery re-scopes user tables to anon ONLY — never service-only tables', () => {
    for (const table of USER_TABLES) {
      expect(code).toMatch(
        new RegExp(
          `alter policy ${table}_deny_all\\s+on marketinghub\\.${table}\\s+to anon;`,
          'i'
        )
      );
    }
    for (const table of SERVICE_ONLY) {
      expect(code).not.toMatch(new RegExp(`alter policy ${table}_deny_all`, 'i'));
    }
  });

  test('grants to authenticated are EXACTLY the matrix + schema usage + view selects', () => {
    expect(code).toMatch(/grant usage on schema marketinghub to authenticated/i);
    for (const table of USER_TABLES) {
      // revoke-then-grant so re-runs converge on the exact matrix
      expect(code).toMatch(
        new RegExp(
          `revoke all on marketinghub\\.${table} from anon, authenticated, public`,
          'i'
        )
      );
      expect(code).toMatch(
        new RegExp(
          `grant ${MATRIX[table].join(', ')} on marketinghub\\.${table} to authenticated`,
          'i'
        )
      );
    }
    for (const view of VIEWS) {
      expect(code).toMatch(
        new RegExp(`grant select on marketinghub\\.${view} to authenticated`, 'i')
      );
    }
    // Enumerate EVERY `grant ... to authenticated` statement in the file and
    // check it against the allowed set — nothing extra may sneak in.
    const grants = code.match(/grant [^;]+ to authenticated/gi) ?? [];
    const allowed = [
      'grant usage on schema marketinghub to authenticated',
      ...USER_TABLES.map(
        (t) => `grant ${MATRIX[t].join(', ')} on marketinghub.${t} to authenticated`
      ),
      ...VIEWS.map((v) => `grant select on marketinghub.${v} to authenticated`),
    ];
    expect(grants.map((g) => g.replace(/\s+/g, ' ').toLowerCase()).sort()).toEqual(
      allowed.map((g) => g.toLowerCase()).sort()
    );
  });

  test('no table grant to authenticated on service-only tables — revoke instead', () => {
    for (const table of SERVICE_ONLY) {
      expect(code).not.toMatch(
        new RegExp(`grant [^;]* on marketinghub\\.${table}[^;]* to authenticated`, 'i')
      );
      expect(code).toMatch(
        new RegExp(
          `revoke all on marketinghub\\.${table} from anon, authenticated, public`,
          'i'
        )
      );
    }
  });

  test('no default privileges and no sequence grants for authenticated', () => {
    expect(code).not.toMatch(/alter default privileges[^;]*to authenticated/i);
    expect(code).not.toMatch(/on all sequences/i);
    expect(code).not.toMatch(/grant usage[^;]*on sequence/i);
    // service_role default privileges are still re-asserted (house block)
    expect(code).toMatch(
      /alter default privileges in schema marketinghub\s+grant all privileges on tables to service_role/i
    );
    expect(code).toMatch(/grant usage on schema marketinghub to service_role/i);
    expect(code).toMatch(
      /grant all privileges on all tables in schema marketinghub to service_role/i
    );
  });

  test('claim_due_sms_recipients stays service_role-only (worker claim path)', () => {
    expect(code).toMatch(
      /revoke execute on function marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*,\s*int\s*,\s*int\s*\)\s+from public\s*,\s*anon\s*,\s*authenticated/i
    );
    expect(code).toMatch(
      /grant execute on function marketinghub\.claim_due_sms_recipients\s*\(\s*int\s*,\s*int\s*,\s*int\s*,\s*int\s*\)\s+to service_role/i
    );
    expect(code).not.toMatch(
      /grant execute on function marketinghub\.claim_due_sms_recipients[^;]*to\s+(anon|authenticated)/i
    );
  });

  test('console_impersonation_audit: contract DDL, ENABLE+FORCE RLS, deny_all(anon, authenticated)', () => {
    const ddlStart = code.indexOf(
      'create table if not exists marketinghub.console_impersonation_audit'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/id\s+uuid primary key default gen_random_uuid\(\)/i);
    expect(ddl).toMatch(/created_at\s+timestamptz not null default now\(\)/i);
    expect(ddl).toMatch(/actor_email\s+text not null/i);
    expect(ddl).toMatch(/claims\s+jsonb not null/i);
    expect(ddl).toMatch(/target_schema\s+text not null/i);
    expect(ddl).toMatch(/target_table\s+text not null/i);
    expect(ddl).toMatch(/row_count\s+int/i);
    expect(ddl).toMatch(/success\s+boolean not null/i);
    expect(ddl).toMatch(/error\s+text/i);
    expect(code).toMatch(
      /alter table marketinghub\.console_impersonation_audit enable row level security/i
    );
    expect(code).toMatch(
      /alter table marketinghub\.console_impersonation_audit force row level security/i
    );
    // deny_all keeps BOTH anon and authenticated (service-only table)
    const polStart = code.indexOf('create policy console_impersonation_audit_deny_all');
    expect(polStart).toBeGreaterThan(-1);
    const pol = code.slice(polStart, code.indexOf(';', polStart));
    expect(pol).toMatch(/as restrictive/i);
    expect(pol).toMatch(/for all/i);
    expect(pol).toMatch(/to anon\s*,\s*authenticated/i);
    expect(pol).toMatch(/using\s*\(\s*false\s*\)/i);
    expect(pol).toMatch(/with check\s*\(\s*false\s*\)/i);
  });

  test('GoTrue custom-access-token hook stub: select event, supabase_auth_admin only', () => {
    const fnStart = code.indexOf(
      'create or replace function marketinghub.custom_access_token_hook'
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/\(\s*event jsonb\s*\)/i);
    expect(fn).toMatch(/returns jsonb/i);
    expect(fn).toMatch(/language sql/i);
    expect(fn).toMatch(/stable/i);
    expect(fn).toMatch(/select event/i);
    expect(code).toMatch(
      /revoke execute on function marketinghub\.custom_access_token_hook\s*\(\s*jsonb\s*\)\s+from public\s*,\s*anon\s*,\s*authenticated/i
    );
    expect(code).toMatch(
      /grant execute on function marketinghub\.custom_access_token_hook\s*\(\s*jsonb\s*\)\s+to supabase_auth_admin/i
    );
    expect(code).toMatch(
      /grant usage on schema marketinghub to supabase_auth_admin/i
    );
  });

  test('header documents apply-as, ordering, and the 8s statement_timeout gotcha', () => {
    expect(sql).toMatch(/APPLY AS supabase_admin/i);
    // Ordering bound must be console-sql (the file re-revokes the console
    // tables that migration creates), NOT merely engagement-suite.
    expect(sql).toMatch(/apply AFTER 2026-08-06-console-sql\.sql/i);
    expect(sql).toMatch(/2026-08-05-engagement-suite\.sql/);
    expect(sql).toMatch(/statement_timeout/i);
  });

  test('runs as ONE transaction: begin first, commit after the last grant/revoke', () => {
    // Load-bearing for post-cutover re-runs: without the wrap, each statement
    // autocommits and live `authenticated` traffic can land between a
    // table's REVOKE and its GRANT (42501 on a healthy deploy).
    const statements = code
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements[0].toLowerCase()).toBe('begin');
    expect(code.match(/^\s*begin\s*;/gim)?.length).toBe(1);
    expect(code.match(/^\s*commit\s*;/gim)?.length).toBe(1);
    const commitAt = statements.findIndex((s) => s.toLowerCase() === 'commit');
    expect(commitAt).toBeGreaterThan(-1);
    // Every grant/revoke sits inside the transaction...
    for (const [i, stmt] of statements.entries()) {
      if (/^(grant|revoke)\b/i.test(stmt)) expect(i).toBeLessThan(commitAt);
    }
    // ...and only the pgrst reload runs after the commit.
    expect(statements.slice(commitAt + 1).map((s) => s.toLowerCase())).toEqual([
      "select pg_notify('pgrst', 'reload schema')",
    ]);
  });

  test('ends with an executable pgrst schema reload', () => {
    expect(sql).toMatch(/select pg_notify\('pgrst',\s*'reload schema'\);/i);
    // it is the LAST statement in the file
    const last = sql.trimEnd();
    expect(last.endsWith("select pg_notify('pgrst', 'reload schema');")).toBe(true);
  });
});
