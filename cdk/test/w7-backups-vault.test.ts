import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..'); // cdk/
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('2026-08-08-w7-backups-vault.sql migration', () => {
  const sql = read('sql/2026-08-08-w7-backups-vault.sql');
  // Comment-stripped view of the file: the structural assertions below must
  // match executable SQL, never prose in `--` comments.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  test('fails loud unless the dated chain created schema marketinghub', () => {
    expect(code).toMatch(/to_regnamespace\('marketinghub'\) is null/i);
    const raises = code.match(/raise exception/gi) ?? [];
    expect(raises.length).toBe(1);
    // the operator instruction: apply the earlier chain first
    expect(code).toMatch(/apply the dated cdk\/sql chain/i);
  });

  test('is idempotent and never drops, truncates, deletes or disables anything', () => {
    expect(code).toMatch(
      /create table if not exists marketinghub\.backup_status\b/i
    );
    expect(code).toMatch(
      /create table if not exists marketinghub\.vault_console_audit\b/i
    );
    expect(code).not.toMatch(/drop\s+table/i);
    expect(code).not.toMatch(/drop\s+schema/i);
    expect(code).not.toMatch(/drop\s+policy/i);
    expect(code).not.toMatch(/drop\s+function/i);
    expect(code).not.toMatch(/truncate/i);
    expect(code).not.toMatch(/delete\s+from/i);
    expect(code).not.toMatch(/disable\s+(row level security|trigger)/i);
    // never touches vault-extension objects: the audit table is OURS, the
    // vault schema belongs to supabase_vault
    expect(code).not.toMatch(/create[^;]*\svault\./i);
    expect(code).not.toMatch(/alter[^;]*\svault\./i);
    expect(code).not.toMatch(/grant[^;]*\son\s+vault\./i);
  });

  test('backup_status: contract DDL — singleton row (id=1 CHECK), verbatim jsonb payload', () => {
    const ddlStart = code.indexOf(
      'create table if not exists marketinghub.backup_status'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/id\s+smallint primary key default 1 check \(id = 1\)/i);
    expect(ddl).toMatch(/payload\s+jsonb not null/i);
    expect(ddl).toMatch(/captured_at\s+timestamptz not null default now\(\)/i);
    expect(code).toMatch(
      /alter table marketinghub\.backup_status enable row level security/i
    );
    expect(code).toMatch(
      /alter table marketinghub\.backup_status force row level security/i
    );
  });

  test('vault_console_audit: contract DDL — METADATA ONLY, no value column ever', () => {
    const ddlStart = code.indexOf(
      'create table if not exists marketinghub.vault_console_audit'
    );
    expect(ddlStart).toBeGreaterThan(-1);
    const ddl = code.slice(ddlStart, code.indexOf(';', ddlStart));
    expect(ddl).toMatch(/id\s+bigint generated always as identity primary key/i);
    expect(ddl).toMatch(/secret_id\s+uuid/i);
    expect(ddl).toMatch(/secret_name\s+text/i);
    expect(ddl).toMatch(/actor\s+text not null/i);
    expect(ddl).toMatch(
      /action\s+text not null check \(action in \('create', 'update', 'delete', 'reveal'\)\)/i
    );
    expect(ddl).toMatch(/created_at\s+timestamptz not null default now\(\)/i);
    // METADATA ONLY: no column that could ever carry a plaintext secret.
    // (secret_id/secret_name identify WHAT was touched — a bare `secret`,
    // `value`, `payload` or `decrypted*` column is a contract violation.)
    expect(ddl).not.toMatch(
      /^\s*(value|new_value|old_value|secret|plaintext|payload|decrypted\w*)\s/im
    );
    expect(code).toMatch(
      /alter table marketinghub\.vault_console_audit enable row level security/i
    );
    expect(code).toMatch(
      /alter table marketinghub\.vault_console_audit force row level security/i
    );
  });

  test('every CREATE POLICY sits behind a pg_policies if-not-exists guard', () => {
    const creates = code.match(/create policy/gi) ?? [];
    const guards =
      code.match(/if not exists\s*\(\s*select 1 from pg_policies/gi) ?? [];
    // authenticated SELECT + deny_all on backup_status, deny_all on the audit
    expect(creates.length).toBe(3);
    expect(guards.length).toBe(creates.length);
  });

  test('backup_status policies: authenticated SELECT using(true) + RESTRICTIVE anon deny_all', () => {
    const selStart = code.indexOf(
      'create policy backup_status_authenticated_select on marketinghub.backup_status'
    );
    expect(selStart).toBeGreaterThan(-1);
    const sel = code.slice(selStart, code.indexOf(';', selStart));
    expect(sel).toMatch(/for select to authenticated using\s*\(\s*true\s*\)/i);
    expect(sel).not.toMatch(/with check/i);

    const denyStart = code.indexOf(
      'create policy backup_status_deny_all on marketinghub.backup_status'
    );
    expect(denyStart).toBeGreaterThan(-1);
    const deny = code.slice(denyStart, code.indexOf(';', denyStart));
    expect(deny).toMatch(
      /as restrictive\s+for all\s+to anon\s+using \(false\)\s+with check \(false\)/i
    );
    // anon ONLY — a restrictive policy naming authenticated would AND-block
    // the permissive SELECT and blank the backups console.
    expect(deny).not.toMatch(/authenticated/i);
    expect(deny).not.toMatch(/to anon\s*,/i);

    // exactly these two policies touch backup_status; no PERMISSIVE write
    // policy ever names it (the host writer rides postgres BYPASSRLS)
    const policies = code
      .split(';')
      .filter(
        (s) =>
          /create policy/i.test(s) && /marketinghub\.backup_status/i.test(s)
      );
    expect(policies.length).toBe(2);
    expect(code).not.toMatch(
      /marketinghub\.backup_status\s+for (insert|update|delete)\b/i
    );
  });

  test('vault_console_audit: the RESTRICTIVE anon deny_all is its ONLY policy — no authenticated path at all', () => {
    const policies = code
      .split(';')
      .filter(
        (s) =>
          /create policy/i.test(s) &&
          /marketinghub\.vault_console_audit/i.test(s)
      );
    expect(policies.length).toBe(1);
    expect(policies[0]).toMatch(/create policy vault_console_audit_deny_all/i);
    expect(policies[0]).toMatch(
      /as restrictive\s+for all\s+to anon\s+using \(false\)\s+with check \(false\)/i
    );
    // pg-meta writes as supabase_admin (superuser) — authenticated must never
    // gain a policy here (audit rows are console-only, defense in depth)
    expect(policies[0]).not.toMatch(/authenticated/i);
  });

  test('grant matrix: schema USAGE + SELECT,INSERT,UPDATE -> postgres and SELECT -> authenticated on backup_status; vault_console_audit gets NOTHING', () => {
    // revoke-then-grant convergence (w4/w5 style) on both tables
    expect(code).toMatch(
      /revoke all on marketinghub\.backup_status from anon, authenticated, public/i
    );
    expect(code).toMatch(
      /revoke all on marketinghub\.vault_console_audit from anon, authenticated, public/i
    );
    // enumerate EVERY grant in the file — nothing extra may sneak in.
    // Schema USAGE for postgres is load-bearing: every earlier migration
    // applies as supabase_admin and never granted postgres schema access,
    // so without it the host cron's upsert dies on "permission denied for
    // schema marketinghub" (verified empirically on 15.8.1.085).
    const grants = (code.match(/grant [^;]+;/gi) ?? []).map((g) =>
      g.replace(/\s+/g, ' ').toLowerCase()
    );
    expect(grants.sort()).toEqual(
      [
        'grant usage on schema marketinghub to postgres;',
        'grant select, insert, update on marketinghub.backup_status to postgres;',
        'grant select on marketinghub.backup_status to authenticated;',
      ].sort()
    );
    // never to anon or public; the host writer never gets DELETE
    // (latest-only upsert); the audit table is never named in a grant
    expect(code).not.toMatch(/grant [^;]+ to (anon|public)\b/i);
    expect(grants.join(' ')).not.toMatch(/delete/);
    expect(grants.join(' ')).not.toMatch(/vault_console_audit/);
  });

  test('release gate: both tables carry the RESTRICTIVE anon deny_all backstop (rls-gate NO_RESTRICTIVE_ANON_POLICY)', () => {
    // cdk/sql/rls-gate.sql returns a row for any marketinghub table without
    // FORCE RLS or without a RESTRICTIVE policy applying to anon — either
    // would deterministically block every release after this file applies.
    for (const table of ['backup_status', 'vault_console_audit']) {
      const denyStart = code.indexOf(
        `create policy ${table}_deny_all on marketinghub.${table}`
      );
      expect(denyStart).toBeGreaterThan(-1);
      const deny = code.slice(denyStart, code.indexOf(';', denyStart));
      expect(deny).toMatch(/as restrictive/i);
      expect(deny).toMatch(/to anon/i);
      expect(code).toMatch(
        new RegExp(
          `alter table marketinghub\\.${table} force row level security`,
          'i'
        )
      );
    }
  });

  test('header documents apply-as, ordering AFTER w5-realtime, and PG 15.8', () => {
    expect(sql).toMatch(/APPLY AS supabase_admin/i);
    // Ordering bound is the Wave-5 migration (the current tail — Wave 6
    // shipped no migration).
    expect(sql).toMatch(/AFTER 2026-08-08-w5-realtime\.sql/i);
    expect(sql).toMatch(/15\.8/);
    // idempotence is documented (safe to re-run, guards converge)
    expect(sql).toMatch(/safe to re-run/i);
    // filename sorts after the w5 file (apply-order is lexicographic)
    expect('2026-08-08-w7-backups-vault.sql' > '2026-08-08-w5-realtime.sql').toBe(
      true
    );
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
    // ...and only the pgrst reload runs after the commit (w4/w5 precedent:
    // NOTIFY fires at commit, the standalone statement lands post-commit).
    expect(statements.slice(commitAt + 1).map((s) => s.toLowerCase())).toEqual([
      "select pg_notify('pgrst', 'reload schema')",
    ]);
  });

  test('ends with an executable pgrst schema reload as the final line', () => {
    expect(sql).toMatch(/select pg_notify\('pgrst',\s*'reload schema'\);/i);
    const last = sql.trimEnd();
    expect(last.endsWith("select pg_notify('pgrst', 'reload schema');")).toBe(
      true
    );
  });
});

describe('backup-status-cron host asset (cdk/assets)', () => {
  const assetPath = path.join(root, 'assets', 'backup-status-cron');
  const script = fs.readFileSync(assetPath, 'utf8');

  test('parses (bash -n) and lints (shellcheck -x -S style) clean', () => {
    // assets.test.ts only auto-lints *.sh + pgbackrest-cron; this asset is
    // extensionless like pgbackrest-cron, so lint it here explicitly.
    execSync(`bash -n "${assetPath}"`, { stdio: 'pipe' });
    execSync(`shellcheck -x -S style "${assetPath}"`, { stdio: 'pipe' });
  });

  test('captures pgbackrest info as JSON for OUR stanza against OUR db container', () => {
    expect(script).toMatch(/readonly STANZA="supabase"/);
    expect(script).toMatch(/readonly DB_CONTAINER="supabase-db"/);
    expect(script).toMatch(/pgbackrest --stanza="\$STANZA" info --output=json/);
  });

  test('health is read from status.code, never the exit code; payload stored VERBATIM', () => {
    // `pgbackrest info` exits 0 even for a missing stanza — the JSON's
    // status.code is the signal, parsed for the LOG LINE only; the upsert
    // must run whatever it says (the console renders honest errors).
    expect(script).toMatch(/\.status\.code/);
    expect(script).not.toMatch(/\$\?/);
    // no branch may gate the upsert on stanza health
    expect(script).not.toMatch(/if\s+\[+[^\]]*status_code[^\]]*\]+/);
  });

  test('upserts via the bootstrap docker-exec psql idiom: stdin heredoc + psql literal', () => {
    expect(script).toMatch(
      /docker exec -i "\$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1/
    );
    // JSON travels as a psql variable, quoted by :'payload' — no SQL escaping.
    // stdin heredoc is load-bearing: psql does NOT interpolate -v variables
    // inside -c strings (verified on the pinned 15.8 image).
    expect(script).toMatch(/-v payload="\$json"/);
    expect(script).toMatch(/:'payload'::jsonb/);
    expect(script).toMatch(/insert into marketinghub\.backup_status/);
    expect(script).toMatch(/on conflict \(id\) do update/);
    expect(script).not.toMatch(/psql[^\n]*-c[^\n]*payload/);
  });

  test('missing landing table (migration unapplied) is a QUIET no-op — exit 0, success metric', () => {
    expect(script).toMatch(/to_regclass\('\$\{TABLE\}'\)/);
    const guardAt = script.indexOf('does not exist yet');
    expect(guardAt).toBeGreaterThan(-1);
    const guardBlock = script.slice(guardAt, script.indexOf('fi', guardAt));
    expect(guardBlock).toMatch(/emit_metric 0/);
    expect(guardBlock).toMatch(/exit 0/);
  });

  test('best-effort BackupStatusJobFailed metric: 1 on reporter failure, 0 on success, publish problems never fatal', () => {
    expect(script).toMatch(/readonly METRIC_NAMESPACE="Supabase\/Backup"/);
    expect(script).toMatch(/readonly METRIC_NAME="BackupStatusJobFailed"/);
    // die() publishes 1 then exits non-zero; clean paths publish 0
    expect(script).toMatch(/die\(\)\s*\{[^}]*emit_metric 1[^}]*exit 1/);
    expect(script).toMatch(/emit_metric 0/);
    expect(script).toMatch(/\|\| log "WARNING: could not publish/);
  });

  test('overlap guard: non-blocking flock — a held lock skips the tick with exit 0 and NO metric', () => {
    // 15-min cadence + a hung run (degraded S3, blocked upsert) must never
    // stack processes/psql connections. Non-blocking: the skip is quiet and
    // metric-free (the run holding the lock owns its own outcome).
    expect(script).toMatch(/readonly LOCK_FILE="\/run\/lock\/backup-status-cron\.lock"/);
    expect(script).toMatch(/exec 9>"\$LOCK_FILE"/);
    expect(script).toMatch(/flock -n 9/);
    const skipAt = script.indexOf('skipping this tick');
    expect(skipAt).toBeGreaterThan(-1);
    const skipBlock = script.slice(skipAt, script.indexOf('fi', skipAt));
    expect(skipBlock).toMatch(/exit 0/);
    expect(skipBlock).not.toMatch(/emit_metric/);
    // the lock is taken before anything talks to postgres or pgbackrest
    expect(script.indexOf('flock -n 9')).toBeLessThan(script.indexOf('to_regclass'));
  });

  test('bounded execution: pgbackrest info and every docker-exec psql ride `timeout`', () => {
    // pgBackRest's default protocol-timeout (~1830s) exceeds the 15-min
    // cadence, and a psql blocked on a table lock would wait forever.
    expect(script).toMatch(/timeout "\$INFO_TIMEOUT" pgbackrest --stanza="\$STANZA" info --output=json/);
    expect(script).toMatch(/timeout "\$PSQL_TIMEOUT" docker exec "\$DB_CONTAINER" psql/);
    expect(script).toMatch(/timeout "\$PSQL_TIMEOUT" docker exec -i "\$DB_CONTAINER" psql/);
    // in-database bounds on the upsert session, belt and braces
    expect(script).toMatch(/set lock_timeout = '10s';/);
    expect(script).toMatch(/set statement_timeout = '30s';/);
    // no unwrapped invocation remains
    for (const line of script.split('\n')) {
      if (/^\s*(json=|reg=)?"?\$?\(?\s*(pgbackrest|docker exec)/.test(line)) {
        expect(line).toMatch(/timeout "\$(INFO|PSQL)_TIMEOUT"/);
      }
    }
  });

  test('captured_at is stamped at CAPTURE time (before the info call), not at commit', () => {
    // a slow capture must not stamp old JSON as fresh — that would defeat
    // the console staleness badge exactly when the repo is unhealthy
    expect(script).toMatch(/captured_at="\$\(date -u /);
    expect(script).toMatch(/-v captured_at="\$captured_at"/);
    expect(script).toMatch(/:'captured_at'::timestamptz/);
    expect(script.indexOf('captured_at="$(date')).toBeLessThan(
      script.indexOf('pgbackrest --stanza="$STANZA"')
    );
    // the upsert must not fall back to a commit-time now()
    const upsertAt = script.indexOf('insert into marketinghub.backup_status');
    expect(script.slice(upsertAt)).not.toMatch(/now\(\)/);
  });

  test('never logs or echoes the payload body (journal hygiene: sizes + status only)', () => {
    // the only $json expansions are the capture, validation, the byte-count
    // log and the psql -v handoff — no `log ... $json` / echo of the body
    expect(script).not.toMatch(/log[^\n]*\$json\b/);
    expect(script).not.toMatch(/echo[^\n]*\$json\b/);
    expect(script).toMatch(/\$\{#json\} bytes/);
  });
});

describe('bootstrap.sh wires the status reporter into first boot (Wave 7)', () => {
  const bootstrap = read('assets/bootstrap.sh');

  test('writes /etc/cron.d/nsight-backup-status: 0644, SHELL/PATH header, */15 cadence', () => {
    expect(bootstrap).toMatch(/install_backup_status_schedule\(\)/);
    const heredocAt = bootstrap.indexOf('cat >/etc/cron.d/nsight-backup-status');
    expect(heredocAt).toBeGreaterThan(-1);
    const heredoc = bootstrap.slice(
      heredocAt,
      bootstrap.indexOf('\nCRON', heredocAt)
    );
    expect(heredoc).toMatch(/SHELL=\/bin\/bash/);
    expect(heredoc).toMatch(/PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
    expect(heredoc).toMatch(
      /\*\/15 \* \* \* \* root \/usr\/local\/bin\/backup-status-cron/
    );
    expect(bootstrap).toMatch(/chmod 0644 \/etc\/cron\.d\/nsight-backup-status/);
  });

  test('reporter schedule installs INSIDE setup_backups — previews (SKIP_BACKUPS) skip it for the honest empty state', () => {
    const fnStart = bootstrap.indexOf('setup_backups() {');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = bootstrap.indexOf('\n}', fnStart);
    const body = bootstrap.slice(fnStart, fnEnd);
    // the preview early-return guards the whole function, reporter included
    expect(body).toMatch(/SKIP_BACKUPS/);
    const callAt = body.indexOf('install_backup_status_schedule');
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(body.indexOf('SKIP_BACKUPS'));
    // after the pgBackRest schedule (crond enablement lives there)
    expect(callAt).toBeGreaterThan(body.indexOf('install_backup_schedule'));
  });
});

describe('compute-stack stages the reporter for first-boot parity (Wave 7)', () => {
  test("stage('backup-status-cron', '/usr/local/bin/backup-status-cron', '0750')", () => {
    // container-health.sh is the cautionary tale: referenced by comments,
    // never staged, never scheduled. The W7 reporter must be BOTH staged
    // (here) and scheduled (bootstrap test above).
    const stack = read('lib/compute-stack.ts');
    expect(stack).toMatch(
      /stage\('backup-status-cron', '\/usr\/local\/bin\/backup-status-cron', '0750'\)/
    );
  });
});
