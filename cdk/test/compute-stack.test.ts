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
