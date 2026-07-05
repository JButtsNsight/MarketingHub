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
