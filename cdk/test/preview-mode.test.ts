import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';

const env = { account: '439024109088', region: 'us-east-1' };

// --- Preview-profile builders (preview: true on every core stack) ---------------
function makePreviewData() {
  const app = new App();
  const f = new FoundationStack(app, 'F', { env, preview: true });
  const d = new DataStack(app, 'D', {
    env,
    preview: true,
    dataKey: f.dataKey,
    backupKey: f.backupKey,
    secretsKey: f.secretsKey,
  });
  return { ft: Template.fromStack(f), dt: Template.fromStack(d) };
}

function makePreviewCompute() {
  const app = new App();
  const f = new FoundationStack(app, 'F', { env, preview: true });
  const n = new NetworkStack(app, 'N', { env, preview: true, logsKey: f.logsKey });
  const d = new DataStack(app, 'D', {
    env,
    preview: true,
    dataKey: f.dataKey,
    backupKey: f.backupKey,
    secretsKey: f.secretsKey,
  });
  const c = new ComputeStack(app, 'C', {
    env,
    preview: true,
    vpc: n.vpc,
    ec2Sg: n.ec2Sg,
    dataKey: f.dataKey,
    storageBucket: d.storageBucket,
    backupBucket: d.backupBucket,
    appConfigSecret: d.appConfigSecret,
    serviceRoleSecret: d.serviceRoleSecret,
    storageCredsSecret: d.storageCredsSecret,
    smtpSecret: d.smtpSecret,
  });
  return { nt: Template.fromStack(n), ct: Template.fromStack(c) };
}

// --- DataStack: buckets are deletable, no Object Lock -----------------------------
test('preview buckets have DeletionPolicy Delete and NO Object Lock', () => {
  const { dt } = makePreviewData();
  const buckets = dt.findResources('AWS::S3::Bucket');
  const bucketVals = Object.values(buckets);
  expect(bucketVals.length).toBe(2);
  for (const b of bucketVals as any[]) {
    // Fully deletable — no COMPLIANCE lock, no RETAIN.
    expect(b.DeletionPolicy).toBe('Delete');
    expect(b.Properties.ObjectLockEnabled).toBeUndefined();
    expect(b.Properties.ObjectLockConfiguration).toBeUndefined();
    // …but still SSE-KMS, versioned, and public-access-blocked.
    expect(b.Properties.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(b.Properties.BucketEncryption).toBeDefined();
    expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  }
});

test('preview buckets enable autoDeleteObjects (a delete-objects custom resource exists)', () => {
  const { dt } = makePreviewData();
  // aws-cdk auto-delete-objects tags each bucket and creates a Custom::S3AutoDeleteObjects.
  dt.resourceCountIs('Custom::S3AutoDeleteObjects', 2);
});

// --- DataStack: no AWS Backup at all in preview -----------------------------------
test('preview drops the AWS Backup vault, plan, and selection entirely', () => {
  const { dt } = makePreviewData();
  dt.resourceCountIs('AWS::Backup::BackupVault', 0);
  dt.resourceCountIs('AWS::Backup::BackupPlan', 0);
  dt.resourceCountIs('AWS::Backup::BackupSelection', 0);
});

// --- DataStack: secrets + service-role CMK are deletable, JWT signer kept ---------
test('preview secrets are deletable but the JWT-signer custom resource is kept', () => {
  const { dt } = makePreviewData();
  const secrets = dt.findResources('AWS::SecretsManager::Secret');
  expect(Object.keys(secrets).length).toBe(4);
  for (const s of Object.values(secrets) as any[]) {
    expect(s.DeletionPolicy).toBe('Delete');
  }
  // Signer + all secret generation are essential — they must remain.
  dt.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  dt.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x' });
});

test('preview service-role CMK is deletable but keeps rotation', () => {
  const { dt } = makePreviewData();
  dt.resourceCountIs('AWS::KMS::Key', 1);
  dt.allResources('AWS::KMS::Key', { DeletionPolicy: 'Delete' });
  dt.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
});

// --- FoundationStack: the 4 CMKs are deletable, rotation intact -------------------
test('preview Foundation CMKs are deletable but keep rotation', () => {
  const { ft } = makePreviewData();
  ft.resourceCountIs('AWS::KMS::Key', 4);
  ft.allResources('AWS::KMS::Key', { DeletionPolicy: 'Delete' });
  ft.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
});

// --- NetworkStack: flow-log group deletable; VPC/endpoints/SGs unchanged ----------
test('preview flow-log group is deletable; VPC and endpoints unchanged', () => {
  const { nt } = makePreviewCompute();
  nt.hasResource('AWS::Logs::LogGroup', { DeletionPolicy: 'Delete' });
  // Network topology is unchanged in preview.
  nt.resourceCountIs('AWS::EC2::NatGateway', 1);
  nt.resourceCountIs('AWS::EC2::VPCEndpoint', 8);
});

// --- ComputeStack: SKIP_BACKUPS in user-data, deletable data volume, host-IP out --
test('preview ComputeStack user-data passes SKIP_BACKUPS to the bootstrap', () => {
  const { ct } = makePreviewCompute();
  const json = JSON.stringify(ct.toJSON());
  expect(json).toContain('SKIP_BACKUPS');
});

test('preview data EBS volume is deleteOnTermination true', () => {
  const { ct } = makePreviewCompute();
  ct.hasResourceProperties('AWS::EC2::Instance', {
    BlockDeviceMappings: Match.arrayWith([
      Match.objectLike({
        Ebs: Match.objectLike({ VolumeSize: 200, DeleteOnTermination: true }),
      }),
    ]),
  });
});

test('preview ComputeStack exports the host private IP', () => {
  const { ct } = makePreviewCompute();
  ct.hasOutput('*', { Export: { Name: 'SupabaseHostPrivateIp' } });
});

// --- Production path is unchanged: no SKIP_BACKUPS, no host-IP export -------------
test('production (default) ComputeStack does NOT set SKIP_BACKUPS or export host IP', () => {
  const app = new App();
  const f = new FoundationStack(app, 'F', { env });
  const n = new NetworkStack(app, 'N', { env, logsKey: f.logsKey });
  const d = new DataStack(app, 'D', {
    env,
    dataKey: f.dataKey,
    backupKey: f.backupKey,
    secretsKey: f.secretsKey,
  });
  const c = new ComputeStack(app, 'C', {
    env,
    vpc: n.vpc,
    ec2Sg: n.ec2Sg,
    dataKey: f.dataKey,
    storageBucket: d.storageBucket,
    backupBucket: d.backupBucket,
    appConfigSecret: d.appConfigSecret,
    serviceRoleSecret: d.serviceRoleSecret,
    storageCredsSecret: d.storageCredsSecret,
    smtpSecret: d.smtpSecret,
  });
  const ct = Template.fromStack(c);
  const json = JSON.stringify(ct.toJSON());
  expect(json).not.toContain('SKIP_BACKUPS');
  const outputs = ct.findOutputs('*');
  const hasHostIp = Object.values(outputs).some(
    (o: any) => o.Export?.Name === 'SupabaseHostPrivateIp',
  );
  expect(hasHostIp).toBe(false);
});

// --- App wiring: preview synthesizes only the 4 core stacks -----------------------
test('previewMode=true synthesizes only Foundation/Network/Data/Compute (no Edge/Observability)', () => {
  // Isolated -o dir (OS temp) so this parallel jest worker's cdk CLI run does not collide
  // with app.test.ts writing the default cdk.out at the same time.
  const outDir = path.join(os.tmpdir(), 'mh-sb-preview-list');
  const out = execSync(`npx cdk list -c previewMode=true -o ${outDir}`, {
    cwd: process.cwd(),
  }).toString();
  expect(out).toContain('SupabaseFoundation');
  expect(out).toContain('SupabaseNetwork');
  expect(out).toContain('SupabaseData');
  expect(out).toContain('SupabaseCompute');
  expect(out).not.toContain('SupabaseEdge');
  expect(out).not.toContain('SupabaseObservability');
});
