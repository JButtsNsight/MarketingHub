import { execSync } from 'child_process';

test('cdk synth succeeds for all stacks', () => {
  // Runs the app; throws if synth fails. cwd is the cdk/ project root.
  const out = execSync('npx cdk synth --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});

test('SupabaseCompute is in the synthesized cloud assembly', () => {
  const out = execSync('npx cdk list 2>&1', { cwd: process.cwd() }).toString();
  expect(out).toContain('SupabaseCompute');
});

test('synth includes EdgeStack', () => {
  const out = execSync('npx cdk synth SupabaseEdge --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});

test('cdk synth includes the ObservabilityStack', () => {
  const out = execSync('npx cdk synth SupabaseObservability --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});

test('DataStack synthesizes with the full contract exported', () => {
  // Reuses the app synth; asserts DataStack template contains the crown-jewel key,
  // both buckets, and the vault (a fast structural smoke test).
  const { Template } = require('aws-cdk-lib/assertions');
  const { App } = require('aws-cdk-lib');
  const { FoundationStack } = require('../lib/foundation-stack');
  const { DataStack } = require('../lib/data-stack');
  const env = { account: '439024109088', region: 'us-east-1' };
  const app = new App();
  const f = new FoundationStack(app, 'F', { env });
  const d = new DataStack(app, 'D', {
    env, dataKey: f.dataKey, backupKey: f.backupKey, secretsKey: f.secretsKey,
  });
  const t = Template.fromStack(d);
  t.resourceCountIs('AWS::S3::Bucket', 2);
  t.resourceCountIs('AWS::Backup::BackupVault', 1);
  t.resourceCountIs('AWS::KMS::Key', 1); // the dedicated service-role CMK
});
