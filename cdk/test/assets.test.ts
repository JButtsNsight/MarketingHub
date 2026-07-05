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
