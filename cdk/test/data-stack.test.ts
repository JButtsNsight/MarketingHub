import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { DataStack } from '../lib/data-stack';

const env = { account: '439024109088', region: 'us-east-1' };

export function makeDataTemplate() {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const data = new DataStack(app, 'Data', {
    env,
    dataKey: foundation.dataKey,
    backupKey: foundation.backupKey,
    secretsKey: foundation.secretsKey,
  });
  return { data, t: Template.fromStack(data) };
}

test('storage bucket is SSE-KMS, versioned, Object-Lock-enabled, and retained', () => {
  const { t } = makeDataTemplate();
  t.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ]),
      },
    }),
  });
});

test('storage bucket denies non-TLS access (enforceSSL)', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Action: 's3:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
      ]),
    }),
  });
});
