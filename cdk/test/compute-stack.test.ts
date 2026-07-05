import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';

const env = { account: '439024109088', region: 'us-east-1' };

// Minimal fixture standing in for Phase 2's DataStack exports so ComputeStack
// can be tested in isolation. Buckets/secrets here mirror the shared contract.
class DataFixture extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly appConfigSecret: secretsmanager.Secret;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly storageCredsSecret: secretsmanager.Secret;
  public readonly smtpSecret: secretsmanager.Secret;
  constructor(scope: Construct, id: string, secretsKey: kms.IKey, props: StackProps) {
    super(scope, id, props);
    this.storageBucket = new s3.Bucket(this, 'Storage');
    this.backupBucket = new s3.Bucket(this, 'Backup');
    const mk = (i: string) => new secretsmanager.Secret(this, i, { encryptionKey: secretsKey });
    this.appConfigSecret = mk('AppConfig');
    this.serviceRoleSecret = mk('ServiceRole');
    this.storageCredsSecret = mk('StorageCreds');
    this.smtpSecret = mk('Smtp');
  }
}

function makeCompute() {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  const data = new DataFixture(app, 'Data', foundation.secretsKey, { env });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    vpc: network.vpc,
    ec2Sg: network.ec2Sg,
    dataKey: foundation.dataKey,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
    appConfigSecret: data.appConfigSecret,
    serviceRoleSecret: data.serviceRoleSecret,
    storageCredsSecret: data.storageCredsSecret,
    smtpSecret: data.smtpSecret,
  });
  return Template.fromStack(compute);
}

test('creates an EC2 instance role with the SSM core managed policy', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } }),
      ]),
    }),
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
        ]),
      }),
    ]),
  });
});

test('role policy reads the specific secret ARNs, never *', () => {
  const t = makeCompute();
  // secretsmanager:GetSecretValue appears and its Resource is a Ref/ARN, not "*".
  const policies = t.findResources('AWS::IAM::Policy');
  const json = JSON.stringify(policies);
  expect(json).toContain('secretsmanager:GetSecretValue');
  // No statement grants GetSecretValue on "*".
  const stmts = Object.values(policies).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement,
  );
  const secretStmts = stmts.filter(
    (s: any) => JSON.stringify(s.Action).includes('secretsmanager:GetSecretValue'),
  );
  expect(secretStmts.length).toBeGreaterThan(0);
  for (const s of secretStmts) {
    expect(s.Resource).not.toEqual('*');
    expect(JSON.stringify(s.Resource)).not.toEqual('"*"');
  }
});

test('role can read/write the backup bucket but is NOT granted the storage bucket', () => {
  const t = makeCompute();
  const policies = t.findResources('AWS::IAM::Policy');
  const stmts = Object.values(policies).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement,
  );
  const s3Puts = stmts.filter((s: any) => JSON.stringify(s.Action).includes('s3:PutObject'));
  expect(s3Puts.length).toBeGreaterThan(0); // backup bucket write exists
  // Storage bucket must NOT appear in any grant. Its logical id starts with "Storage".
  // (DataFixture names it "Storage"; the backup bucket "Backup".) The role's policy
  // should reference only the Backup bucket ARN, so no Storage ARN is present.
  const json = JSON.stringify(stmts);
  expect(json).not.toMatch(/Storage[0-9A-F]{8}/); // no Storage bucket logical ref
});

test('instance is m6i.xlarge with IMDSv2 hop-limit 1', () => {
  const t = makeCompute();
  // The individual metadata-option props land as MetadataOptions directly on the
  // AWS::EC2::Instance resource (this CDK version forbids requireImdsv2 + hop-limit,
  // so no LaunchTemplate is used). Assert the security-critical values: IMDSv2 required
  // and hop-limit 1 (blocks a container reaching IMDS via SSRF — spec §7).
  t.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 'm6i.xlarge',
    MetadataOptions: Match.objectLike({
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 1,
    }),
  });
});

test('root and data volumes are both KMS-encrypted gp3', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::EC2::Instance', {
    BlockDeviceMappings: Match.arrayWith([
      // root 50GB gp3 encrypted with a CMK (KmsKeyId present, not the default key)
      Match.objectLike({
        Ebs: Match.objectLike({
          VolumeSize: 50, VolumeType: 'gp3', Encrypted: true, KmsKeyId: Match.anyValue(),
        }),
      }),
      // data 200GB gp3 encrypted with a CMK, retained on terminate
      Match.objectLike({
        Ebs: Match.objectLike({
          VolumeSize: 200, VolumeType: 'gp3', Encrypted: true,
          KmsKeyId: Match.anyValue(), DeleteOnTermination: false,
        }),
      }),
    ]),
  });
});

test('the data volume carries the supabase:backup=true tag (Phase 2 BackupSelection hook)', () => {
  const t = makeCompute();
  // CFN block-device mappings cannot carry per-volume tags directly; the ONLY way the
  // instance tag reaches the attached EBS volumes at launch is
  // PropagateTagsToVolumeOnCreation=true on the instance. Without it, Phase 2's
  // BackupSelection.fromTag('supabase:backup','true') matches ZERO volumes (the tag
  // lives only on the instance). Assert both the tag value AND propagation.
  t.hasResourceProperties('AWS::EC2::Instance', {
    PropagateTagsToVolumeOnCreation: true,
    Tags: Match.arrayWith([
      Match.objectLike({ Key: 'supabase:backup', Value: 'true' }),
    ]),
  });
});

test('instance user-data references the bootstrap and exports the secret ARNs', () => {
  const t = makeCompute();
  // UserData is base64-encoded in the launch template. Assert the decoded form
  // contains our exported vars + the bootstrap invocation.
  const template = t.toJSON();
  const json = JSON.stringify(template);
  // The user-data is a Fn::Base64 of a joined string; the var names appear in the
  // (unencoded) Fn::Join parts.
  expect(json).toContain('APP_CONFIG_SECRET_ARN');
  expect(json).toContain('STORAGE_CREDS_SECRET_ARN');
  expect(json).toContain('bootstrap.sh');
});

test('instance user-data stays within the EC2 16 KB hard limit', () => {
  const t = makeCompute();
  const template = t.toJSON();
  // Find the AWS::EC2::Instance and pull its UserData (Fn::Base64 -> Fn::Join -> parts).
  const instances = Object.values(template.Resources as Record<string, any>).filter(
    (r: any) => r.Type === 'AWS::EC2::Instance',
  );
  expect(instances.length).toBe(1);
  const ud = instances[0].Properties.UserData;
  const parts = ud['Fn::Base64']['Fn::Join'][1] as unknown[];
  // Sum literal string bytes; count each unresolved intrinsic generously (128 bytes,
  // covers ARNs/bucket names resolved at deploy). This is the raw (pre-base64) size EC2
  // caps at 16384 bytes. Inlining the five assets blew past this (~17 KB) — assets are
  // now delivered out-of-band via S3, so user-data must stay well under the limit.
  let bytes = 0;
  for (const p of parts) {
    bytes += typeof p === 'string' ? Buffer.byteLength(p, 'utf8') : 128;
  }
  expect(bytes).toBeLessThan(16384);
});

test('auto-recovery alarm on StatusCheckFailed_System with an EC2 recover action', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/EC2',
    MetricName: 'StatusCheckFailed_System',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    Threshold: 1,
    // The recover action ARN is arn:<partition>:automate:<region>:ec2:recover
    AlarmActions: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('automate')]),
        ]),
      }),
    ]),
  });
});
