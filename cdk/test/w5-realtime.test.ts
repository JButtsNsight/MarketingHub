import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// Trigger wiring: name, TG_ARGV[0] topic suffix, and the exact event list.
// Only sms_campaigns broadcasts DELETE (schedule view must drop rows).
const TRIGGERS = [
  {
    table: 'sms_inbound_messages',
    name: 'sms_inbound_messages_mh_notify',
    arg: 'inbox',
    events: 'after insert or update',
    hasDelete: false,
  },
  {
    table: 'sms_campaigns',
    name: 'sms_campaigns_mh_notify',
    arg: 'schedule',
    events: 'after insert or update or delete',
    hasDelete: true,
  },
  {
    table: 'sms_campaign_recipients',
    name: 'sms_campaign_recipients_mh_notify',
    arg: 'campaigns',
    events: 'after insert or update',
    hasDelete: false,
  },
];

describe('2026-08-08-w5-realtime.sql migration', () => {
  const sql = read('sql/2026-08-08-w5-realtime.sql');
  // Comment-stripped view of the file: the structural assertions below must
  // match executable SQL, never prose in `--` comments.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  test('fails loud unless the realtime container has seeded its schema', () => {
    // to_regclass guard on realtime.messages + pg_proc guard on realtime.send
    expect(code).toMatch(/to_regclass\('realtime\.messages'\) is null/i);
    expect(code).toMatch(
      /from pg_proc p\s+join pg_namespace n on n\.oid = p\.pronamespace\s+where n\.nspname = 'realtime'\s+and p\.proname = 'send'/i
    );
    const raises = code.match(/raise exception/gi) ?? [];
    expect(raises.length).toBe(2);
    // the operator instruction the contract requires
    expect(code).toMatch(/start the realtime container first/i);
    // guard only — never creates realtime-owned objects
    expect(code).not.toMatch(/create table[^;]*realtime\.messages/i);
    expect(code).not.toMatch(/create (or replace )?function realtime\./i);
  });

  test('is idempotent and never drops or disables anything', () => {
    expect(code).toMatch(
      /create table if not exists marketinghub\.edge_functions\b/i
    );
    expect(code).toMatch(
      /create or replace function marketinghub\.tg_mh_notify/i
    );
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/drop\s+schema/i);
    expect(code).not.toMatch(/drop\s+policy/i);
    expect(code).not.toMatch(/drop\s+function/i);
    expect(code).not.toMatch(/drop\s+trigger/i);
    expect(code).not.toMatch(/drop\s+publication/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/alter publication[^;]*(drop|set)\s+table/i);
    expect(code).not.toMatch(/disable\s+(row level security|trigger)/i);
  });

  test('postgres_changes stays OFF: no publication membership, no replica identity change (PII minimization)', () => {
    // With W4's group-wide USING(true) RLS, postgres_changes would stream
    // FULL ROWS (phone_e164, bodies, raw webhook JSON) to any anon-key +
    // user-JWT holder over the browser-reachable /realtime/v1/* path. The
    // migration must never opt the live tables into it.
    expect(code).not.toMatch(/create publication/i);
    expect(code).not.toMatch(/alter publication/i);
    expect(code).not.toMatch(/replica identity/i);
    expect(code).not.toMatch(/pg_publication/i);
    // ...and the rationale is documented for the next editor.
    expect(sql).toMatch(/DELIBERATELY ABSENT/);
    expect(sql).toMatch(/postgres_changes/);
  });

  test('tenant hardening: private_only converges under existence guards, NOTICE (never abort) when unsupported', () => {
    // Guarded on both the table and the column existing — old realtime
    // images without private_only must skip with a notice, not fail the
    // single-transaction apply.
    expect(code).toMatch(/to_regclass\('_realtime\.tenants'\) is not null/i);
    expect(code).toMatch(
      /table_schema = '_realtime'\s+and table_name\s+= 'tenants'\s+and column_name\s+= 'private_only'/i
    );
    expect(code).toMatch(
      /update _realtime\.tenants\s+set private_only = true\s+where private_only is distinct from true/i
    );
    expect(code).toMatch(/raise notice/i);
    // the fallback is a NOTICE — the only exceptions are the two boot guards
    expect((code.match(/raise exception/gi) ?? []).length).toBe(2);
  });

  test('every CREATE POLICY sits behind a pg_policies if-not-exists guard', () => {
    const creates = code.match(/create policy/gi) ?? [];
    const guards =
      code.match(/if not exists\s*\(\s*select 1 from pg_policies/gi) ?? [];
    // mh_recv + mh_send on realtime.messages, SELECT + deny_all on the registry
    expect(creates.length).toBe(4);
    expect(guards.length).toBe(creates.length);
  });

  test('realtime.messages channel policies: mh_recv SELECT on mh:%, mh_send INSERT on mh:inspector:% ONLY', () => {
    const recvStart = code.indexOf('create policy mh_recv on realtime.messages');
    expect(recvStart).toBeGreaterThan(-1);
    const recv = code.slice(recvStart, code.indexOf(';', recvStart));
    expect(recv).toMatch(/for select to authenticated/i);
    expect(recv).toMatch(
      /using\s*\(\s*realtime\.messages\.extension in \('broadcast',\s*'presence'\)\s+and realtime\.topic\(\) like 'mh:%'\s*\)/i
    );
    expect(recv).not.toMatch(/with check/i);

    // SEND is confined to the Inspector scratch namespace — the trigger-owned
    // live-view topics (mh:inbox / mh:schedule / mh:campaigns /
    // mh:campaign:<id>) must never be user-writable, or any authenticated
    // user could forge `change` events that drive every other user's browser
    // into router.refresh() loops.
    const sendStart = code.indexOf('create policy mh_send on realtime.messages');
    expect(sendStart).toBeGreaterThan(-1);
    const send = code.slice(sendStart, code.indexOf(';', sendStart));
    expect(send).toMatch(/for insert to authenticated/i);
    expect(send).toMatch(
      /with check\s*\(\s*realtime\.messages\.extension in \('broadcast',\s*'presence'\)\s+and realtime\.topic\(\) like 'mh:inspector:%'\s*\)/i
    );
    expect(send).not.toMatch(/using/i);
    expect(send).not.toMatch(/like 'mh:%'/); // never namespace-wide send

    // exactly these two policies touch realtime.messages: no anon access,
    // no restrictive policy that would AND against realtime's own machinery
    const messagesPolicies = code
      .split(';')
      .filter(
        (s) => /create policy/i.test(s) && /on realtime\.messages/i.test(s)
      );
    expect(messagesPolicies.length).toBe(2);
    for (const p of messagesPolicies) {
      expect(p).not.toMatch(/to anon/i);
      expect(p).not.toMatch(/as restrictive/i);
    }
  });

  test('never touches RLS state or grants on realtime-owned tables', () => {
    // tenant migrations own realtime.messages RLS — no enable/force, no
    // grants, no ALTER of any kind on the realtime schema
    expect(code).not.toMatch(/alter table realtime\./i);
    expect(code).not.toMatch(/grant [^;]* on [^;]*realtime\./i);
    expect(code).not.toMatch(/revoke [^;]* on [^;]*realtime\./i);
  });

  test('edge_functions registry: contract DDL + ENABLE+FORCE RLS', () => {
    const ddlStart = code.indexOf(
      'create table if not exists marketinghub.edge_functions'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/name\s+text primary key/i);
    expect(ddl).toMatch(/source\s+text not null/i);
    expect(ddl).toMatch(/version\s+text not null default '0'/i);
    expect(ddl).toMatch(/updated_at\s+timestamptz not null default now\(\)/i);
    expect(ddl).toMatch(/deployed_at\s+timestamptz/i);
    expect(ddl).toMatch(/notes\s+text/i);
    expect(code).toMatch(
      /alter table marketinghub\.edge_functions enable row level security/i
    );
    expect(code).toMatch(
      /alter table marketinghub\.edge_functions force row level security/i
    );
  });

  test('registry is read-only for authenticated: SELECT policy + anon deny_all, NO write policies', () => {
    const policies = code
      .split(';')
      .filter(
        (s) =>
          /create policy/i.test(s) && /marketinghub\.edge_functions/i.test(s)
      );
    expect(policies.length).toBe(2);
    const select = policies.find((p) => /for select/i.test(p));
    expect(select).toBeDefined();
    expect(select).toMatch(
      /create policy edge_functions_authenticated_select on marketinghub\.edge_functions\s+for select to authenticated using\s*\(\s*true\s*\)/i
    );
    expect(select).not.toMatch(/with check/i);
    // no PERMISSIVE insert/update/delete/all policy ever names the registry
    // (the deny_all below is `as restrictive`, so this regex cannot match it)
    expect(code).not.toMatch(
      /marketinghub\.edge_functions\s+for (insert|update|delete|all)\b/i
    );
    expect(code).not.toMatch(
      /edge_functions_authenticated_(insert|update|delete|all)/i
    );
  });

  test('release gate: edge_functions carries the RESTRICTIVE anon deny_all backstop (rls-gate NO_RESTRICTIVE_ANON_POLICY)', () => {
    // cdk/scripts/rls-gate.sh exits non-zero for any marketinghub table with
    // zero RESTRICTIVE policies applying to anon/public — without this
    // backstop, applying W5 would deterministically block every release.
    const denyStart = code.indexOf(
      'create policy edge_functions_deny_all on marketinghub.edge_functions'
    );
    expect(denyStart).toBeGreaterThan(-1);
    const deny = code.slice(denyStart, code.indexOf(';', denyStart));
    expect(deny).toMatch(
      /as restrictive\s+for all\s+to anon\s+using \(false\)\s+with check \(false\)/i
    );
    // anon ONLY — a restrictive policy naming authenticated would AND-block
    // the permissive SELECT and blank the /functions console.
    expect(deny).not.toMatch(/authenticated/i);
    expect(deny).not.toMatch(/to anon\s*,/i);
  });

  test('grant matrix: SELECT->authenticated and ALL->service_role on the registry, nothing else', () => {
    // revoke-then-grant convergence (w4 style)
    expect(code).toMatch(
      /revoke all on marketinghub\.edge_functions from anon, authenticated, public/i
    );
    expect(code).toMatch(
      /grant select on marketinghub\.edge_functions to authenticated/i
    );
    expect(code).toMatch(
      /grant all privileges on marketinghub\.edge_functions to service_role/i
    );
    // enumerate EVERY grant in the file — nothing extra may sneak in
    const grants = (code.match(/grant [^;]+;/gi) ?? []).map((g) =>
      g.replace(/\s+/g, ' ').toLowerCase()
    );
    expect(grants.sort()).toEqual(
      [
        'grant select on marketinghub.edge_functions to authenticated;',
        'grant all privileges on marketinghub.edge_functions to service_role;',
      ].sort()
    );
    // never to anon or public
    expect(code).not.toMatch(/grant [^;]+ to (anon|public)\b/i);
  });

  test('tg_mh_notify broadcasts ids ONLY and can never fail DML', () => {
    const fnStart = code.indexOf(
      'create or replace function marketinghub.tg_mh_notify'
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fn = code.slice(fnStart, code.indexOf('$$;', fnStart));
    expect(fn).toMatch(/returns trigger/i);
    expect(fn).toMatch(/language plpgsql/i);
    expect(fn).toMatch(/rec\s*:=\s*to_jsonb\(coalesce\(new, old\)\)/i);

    // payload = {table, op, id} — ids ONLY, no row data / PII columns
    const bStart = fn.indexOf('jsonb_build_object');
    expect(bStart).toBeGreaterThan(-1);
    const builder = fn.slice(bStart, fn.indexOf(')', fn.indexOf("rec ->> 'id'")));
    expect(builder).toMatch(/'table',\s*tg_table_name/i);
    expect(builder).toMatch(/'op',\s*tg_op/i);
    expect(builder).toMatch(/'id',\s*rec ->> 'id'/i);
    expect(builder).not.toMatch(/phone|body|raw|record|payload,/i);

    // both sends: private mh:* topics, event 'change', payload only —
    // never the rec/row itself, never broadcast_changes (ships full rows)
    expect(fn).toMatch(
      /perform realtime\.send\(payload,\s*'change',\s*'mh:'\s*\|\|\s*tg_argv\[0\],\s*true\)/i
    );
    expect(fn).toMatch(
      /perform realtime\.send\(payload,\s*'change',\s*'mh:campaign:'\s*\|\|\s*\(rec ->> 'campaign_id'\),\s*true\)/i
    );
    expect((fn.match(/realtime\.send\(/gi) ?? []).length).toBe(2);
    expect((fn.match(/realtime\.send\(payload,/gi) ?? []).length).toBe(2);
    expect(fn).not.toMatch(/broadcast_changes/i);

    // campaign fan-out is null-safe (a null campaign_id must not abort the
    // subtransaction and swallow the primary send)
    expect(fn).toMatch(
      /if \(rec \? 'campaign_id'\) and \(rec ->> 'campaign_id'\) is not null then/i
    );

    // whole body wrapped: any broadcast error is swallowed
    expect(fn).toMatch(/exception\s+when others then\s+null;/i);
    expect(fn).toMatch(/return null;/i);
  });

  test('triggers: guarded, per-table topics, DELETE only on sms_campaigns', () => {
    for (const t of TRIGGERS) {
      // pg_trigger guard names the exact table + trigger
      expect(code).toMatch(
        new RegExp(
          `and c\\.relname = '${t.table}'\\s+and t\\.tgname\\s+= '${t.name}'`,
          'i'
        )
      );
      const start = code.indexOf(`create trigger ${t.name}`);
      expect(start).toBeGreaterThan(-1);
      const stmt = code.slice(start, code.indexOf(';', start));
      expect(stmt).toMatch(
        new RegExp(`${t.events} on marketinghub\\.${t.table}\\b`, 'i')
      );
      expect(stmt).toMatch(/for each row/i);
      expect(stmt).toMatch(
        new RegExp(
          `execute function marketinghub\\.tg_mh_notify\\('${t.arg}'\\)`,
          'i'
        )
      );
      if (!t.hasDelete) expect(stmt).not.toMatch(/delete/i);
    }
    // guard count == trigger count, no unguarded trigger
    const creates = code.match(/create trigger/gi) ?? [];
    const guards = code.match(/select 1\s+from pg_trigger/gi) ?? [];
    expect(creates.length).toBe(TRIGGERS.length);
    expect(guards.length).toBe(creates.length);
  });

  test('header documents apply-as, ordering AFTER w4-user-rls, and PG 15.8', () => {
    expect(sql).toMatch(/APPLY AS supabase_admin/i);
    // Ordering bound is the Wave-4 migration (the new tail), not merely an
    // earlier one — the registry grants assume W4's authenticated posture.
    expect(sql).toMatch(/AFTER 2026-08-08-w4-user-rls\.sql/i);
    expect(sql).toMatch(/15\.8/);
    // idempotence is documented (safe to re-run, guards converge)
    expect(sql).toMatch(/safe to re-run/i);
    // filename sorts after the w4 file (apply-order is lexicographic)
    expect('2026-08-08-w5-realtime.sql' > '2026-08-08-w4-user-rls.sql').toBe(true);
  });

  test('runs as ONE transaction: begin first, commit after every grant/revoke', () => {
    const statements = code
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements[0].toLowerCase()).toBe('begin');
    expect(code.match(/^\s*begin\s*;/gim)?.length).toBe(1);
    expect(code.match(/^\s*commit\s*;/gim)?.length).toBe(1);
    const commitAt = statements.findIndex((s) => s.toLowerCase() === 'commit');
    expect(commitAt).toBeGreaterThan(-1);
    // Every grant/revoke (and everything else) sits inside the transaction...
    for (const [i, stmt] of statements.entries()) {
      if (/^(grant|revoke)\b/i.test(stmt)) expect(i).toBeLessThan(commitAt);
    }
    // ...and only the pgrst reload runs after the commit (w4 precedent:
    // NOTIFY fires at commit, the standalone statement lands post-commit).
    expect(statements.slice(commitAt + 1).map((s) => s.toLowerCase())).toEqual([
      "select pg_notify('pgrst', 'reload schema')",
    ]);
  });

  test('ends with an executable pgrst schema reload', () => {
    expect(sql).toMatch(/select pg_notify\('pgrst',\s*'reload schema'\);/i);
    const last = sql.trimEnd();
    expect(last.endsWith("select pg_notify('pgrst', 'reload schema');")).toBe(true);
  });
});
