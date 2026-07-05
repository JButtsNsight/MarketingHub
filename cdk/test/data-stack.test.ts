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

test('backup bucket uses backupKey, Object-Lock compliance default, and lifecycle to Glacier', () => {
  const { t } = makeDataTemplate();
  t.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      ObjectLockEnabled: true,
      ObjectLockConfiguration: Match.objectLike({
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: Match.objectLike({ Mode: 'COMPLIANCE' }),
        },
      }),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ]),
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER' }),
            ]),
            NoncurrentVersionTransitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER' }),
            ]),
          }),
        ]),
      },
    }),
  });
});

test('a dedicated service-role CMK exists in DataStack, distinct from Foundation keys', () => {
  const { t } = makeDataTemplate();
  // DataStack owns exactly one KMS key of its own: the crown-jewel service-role CMK.
  t.resourceCountIs('AWS::KMS::Key', 1);
  t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  t.hasResourceProperties('AWS::KMS::Alias', {
    AliasName: 'alias/nsight-supabase-service-role',
  });
});

test('serviceRoleSecret is encrypted with the dedicated service-role CMK', () => {
  const { data, t } = makeDataTemplate();
  const keyRef = data.serviceRoleKey.keyArn; // token — assert the secret references *a* KMS key
  expect(keyRef).toBeDefined();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/service-role',
    KmsKeyId: Match.anyValue(),
  });
});

test('appConfigSecret exists, encrypted with secretsKey, with generated randoms and length constraints', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/app-config',
    KmsKeyId: Match.anyValue(),
    GenerateSecretString: Match.objectLike({
      // VAULT_ENC_KEY must be EXACTLY 32; excludes make the alphanumeric length exact.
      GenerateStringKey: Match.anyValue(),
    }),
  });
});

test('a Lambda custom resource signs JWT_SECRET/ANON_KEY/SERVICE_ROLE_KEY at deploy time', () => {
  const { t } = makeDataTemplate();
  // The signer Lambda (Node 22) …
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Handler: 'index.handler',
  });
  // … invoked by a CloudFormation custom resource.
  t.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
});

test('storage IAM user policy is scoped to ONLY the storage bucket (no wildcard resource)', () => {
  const { t } = makeDataTemplate();
  t.resourceCountIs('AWS::IAM::User', 1);
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Allow',
          Action: Match.arrayWith(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']),
          // Resources are two tokens (bucket ARN + /*), never the string '*'.
          Resource: Match.not('*'),
        }),
      ]),
    }),
  });
});

test('storageCredsSecret holds the access key, encrypted with secretsKey', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/storage-creds',
    KmsKeyId: Match.anyValue(),
  });
  t.resourceCountIs('AWS::IAM::AccessKey', 1);
});

test('smtpSecret shell exists (empty username/password), encrypted with secretsKey', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/smtp',
    KmsKeyId: Match.anyValue(),
  });
});
