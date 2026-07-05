import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const assetsDir = path.join(__dirname, '..', 'assets');

function shellAssets(): string[] {
  if (!fs.existsSync(assetsDir)) return [];
  return fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.sh') || f === 'pgbackrest-cron')
    .map((f) => path.join(assetsDir, f));
}

test('at least the bootstrap asset exists', () => {
  const files = shellAssets().map((f) => path.basename(f));
  expect(files).toContain('bootstrap.sh');
});

test('compose override binds Kong Admin to 127.0.0.1 only', () => {
  const override = fs.readFileSync(
    path.join(assetsDir, 'docker-compose.override.yml'), 'utf8',
  );
  // Kong Admin (8001) and Manager (8002) must be loopback-bound; the proxy (8000)
  // is NOT bound to loopback (it is reached via the SG from internal clients).
  expect(override).toMatch(/127\.0\.0\.1:8001/);
  expect(override).toMatch(/127\.0\.0\.1:8444/);
  expect(override).toMatch(/127\.0\.0\.1:8002/);
});

test('render-env.sh injects AWS creds only into the storage service', () => {
  const renderEnv = fs.readFileSync(
    path.join(assetsDir, 'render-env.sh'), 'utf8',
  );
  // Storage-scoped keys present; a comment documents the omit-for-others rule.
  expect(renderEnv).toMatch(/STORAGE_BACKEND=s3/);
  expect(renderEnv).toMatch(/STORAGE_S3_FORCE_PATH_STYLE=false/);
});

test('render-env.sh validates crown-jewel secret lengths (spec §13)', () => {
  const renderEnv = fs.readFileSync(
    path.join(assetsDir, 'render-env.sh'), 'utf8',
  );
  // §13: SECRET_KEY_BASE >= 64, VAULT_ENC_KEY exactly 32. A mis-provisioned key must
  // abort loudly at bootstrap, not surface later as an opaque GoTrue/Vault crash-loop.
  expect(renderEnv).toMatch(/\$\{#SECRET_KEY_BASE\}.*-lt 64|-lt 64.*SECRET_KEY_BASE|\$\{#SECRET_KEY_BASE\}.*-ge 64/);
  expect(renderEnv).toMatch(/\$\{#VAULT_ENC_KEY\}.*-ne 32|-ne 32.*VAULT_ENC_KEY|\$\{#VAULT_ENC_KEY\}.*-eq 32/);
});

test('compose override binds Postgres PGDATA to the dedicated data volume (spec §7)', () => {
  const override = fs.readFileSync(
    path.join(assetsDir, 'docker-compose.override.yml'), 'utf8',
  );
  // The db service MUST remap the bundle's default ./volumes/db/data mount (root vol)
  // onto the dedicated encrypted data volume, or all Postgres/PHI state lands on the
  // ephemeral root volume and is lost on instance replacement (spec §7).
  expect(override).toMatch(/^\s{2}db:/m);
  expect(override).toMatch(/\/mnt\/pgdata\/db\/data:\/var\/lib\/postgresql\/data/);
});

test('pgbackrest assets exist', () => {
  const files = fs.readdirSync(assetsDir);
  expect(files).toContain('pgbackrest.conf');
  expect(files).toContain('pgbackrest-cron');
});

describe('shell assets parse and lint clean', () => {
  const files = shellAssets();
  // Guard: if discovery returns nothing the describe body is empty and the
  // suite would falsely pass — the test above catches the missing bootstrap.
  for (const file of files) {
    test(`bash -n ${path.basename(file)}`, () => {
      execSync(`bash -n "${file}"`, { stdio: 'pipe' });
    });
    test(`shellcheck ${path.basename(file)}`, () => {
      // -x follows sourced files; -S style surfaces everything.
      execSync(`shellcheck -x -S style "${file}"`, { stdio: 'pipe' });
    });
  }
});
