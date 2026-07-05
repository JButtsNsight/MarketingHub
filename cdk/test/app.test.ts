import { execSync } from 'child_process';

test('cdk synth succeeds for all stacks', () => {
  // Runs the app; throws if synth fails. cwd is the cdk/ project root.
  const out = execSync('npx cdk synth --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});
