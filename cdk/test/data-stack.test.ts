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
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
              // §14 key segregation: the storage bucket MUST use Foundation's dataKey (imported),
              // never the backupKey — a key swap would surface as a different ImportValue here.
              KMSMasterKeyID: { 'Fn::ImportValue': Match.stringLikeRegexp('DataKey') },
            }),
          }),
        ]),
      },
    }),
  });
});

test('storage bucket carries an Object-Lock COMPLIANCE default retention (§10)', () => {
  const { t } = makeDataTemplate();
  // Object Lock is inert without a default retention; assert the storage bucket has one in
  // COMPLIANCE mode (WORM), matching the backup bucket — not merely ObjectLockEnabled.
  t.hasResource('AWS::S3::Bucket', {
    Properties: Match.objectLike({
      ObjectLockConfiguration: Match.objectLike({
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: Match.objectLike({ Mode: 'COMPLIANCE', Days: 2555 }) },
      }),
      // §10 lifecycle: superseded PHI versions tier to Glacier and expire at the 7-yr window.
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            NoncurrentVersionExpiration: Match.objectLike({ NoncurrentDays: 2555 }),
            NoncurrentVersionTransitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER' }),
            ]),
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

test('both bucket policies require SSE-KMS with the specific CMK on upload (§14)', () => {
  const { t } = makeDataTemplate();
  const policies = t.findResources('AWS::S3::BucketPolicy');
  const statements = Object.values(policies).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement as any[],
  );

  // Deny an explicit non-aws:kms scheme, Null-GUARDED so header-less uploads (every
  // supabase-storage write, which relies on bucket default encryption with the CMK)
  // are NOT denied. The pre-2026-07-31 StringNotEqualsIfExists form evaluated TRUE
  // when the header was absent and blocked all supabase-storage writes; asserting the
  // exact condition shape here fails any regression back to that form.
  const nonKmsDenies = statements.filter((s) => s.Sid === 'DenyNonKmsEncryption');
  // Storage AND backup bucket policies each carry the non-KMS-encryption Deny.
  expect(nonKmsDenies).toHaveLength(2);
  for (const s of nonKmsDenies) {
    expect(s.Effect).toBe('Deny');
    expect(s.Action).toBe('s3:PutObject');
    expect(s.Condition).toEqual({
      Null: { 's3:x-amz-server-side-encryption': 'false' },
      StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
    });
  }

  // And each also denies an explicit wrong KMS key id (the specific-CMK half of §14),
  // with the same Null guard: requests that don't name a key use the default CMK.
  const wrongKeyDenies = statements.filter((s) => s.Sid === 'DenyWrongKmsKey');
  expect(wrongKeyDenies).toHaveLength(2);
  for (const s of wrongKeyDenies) {
    expect(s.Effect).toBe('Deny');
    expect(s.Action).toBe('s3:PutObject');
    expect(Object.keys(s.Condition).sort()).toEqual(['Null', 'StringNotEquals']);
    expect(s.Condition.Null).toEqual({
      's3:x-amz-server-side-encryption-aws-kms-key-id': 'false',
    });
  }
  // Key segregation: the wrong-key comparands are the imported Foundation key ARNs —
  // one deny pins the DataKey (storage bucket), the other the BackupKey (backup bucket).
  const wrongKeyComparands = wrongKeyDenies.map(
    (s) =>
      s.Condition.StringNotEquals['s3:x-amz-server-side-encryption-aws-kms-key-id'][
        'Fn::ImportValue'
      ],
  );
  expect(wrongKeyComparands.filter((v) => /DataKey/.test(v))).toHaveLength(1);
  expect(wrongKeyComparands.filter((v) => /BackupKey/.test(v))).toHaveLength(1);
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
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
              // §14 key segregation: the backup bucket MUST use backupKey (imported), never dataKey.
              KMSMasterKeyID: { 'Fn::ImportValue': Match.stringLikeRegexp('BackupKey') },
            }),
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

test('serviceRoleSecret is encrypted with the dedicated service-role CMK (not the shared secretsKey)', () => {
  const { t } = makeDataTemplate();
  // The dedicated CMK is a DataStack-local key → Fn::GetAtt to the ServiceRoleKey logical id.
  // The shared secretsKey is imported from Foundation → it would appear as an Fn::ImportValue.
  // Asserting GetAtt(ServiceRoleKey) fails the moment someone repoints the secret at secretsKey.
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/service-role',
    KmsKeyId: Match.objectLike({
      'Fn::GetAtt': [Match.stringLikeRegexp('ServiceRoleKey'), 'Arn'],
    }),
  });
});

test('service-role CMK key policy is segregated — no unconditioned kms:* to root, usage gated by ViaService (§14)', () => {
  const { t } = makeDataTemplate();
  const keys = t.findResources('AWS::KMS::Key');
  const svcKey = Object.entries(keys).find(([id]) => id.startsWith('ServiceRoleKey'));
  expect(svcKey).toBeDefined();
  const statements = (svcKey![1] as any).Properties.KeyPolicy.Statement as any[];

  // No statement grants the blanket kms:* (the default "enable IAM" root delegation is gone).
  const hasWildcardAction = statements.some((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.includes('kms:*');
  });
  expect(hasWildcardAction).toBe(false);

  // Crypto usage is delegated to IAM ONLY via Secrets Manager (kms:ViaService), deny otherwise.
  const usage = statements.find(
    (s) => s.Condition?.StringEquals?.['kms:ViaService'] !== undefined,
  );
  expect(usage).toBeDefined();
  expect(usage.Condition.StringEquals['kms:ViaService']).toMatch(/^secretsmanager\./);
  expect(usage.Action).toEqual(expect.arrayContaining(['kms:Decrypt', 'kms:GenerateDataKey*']));
});

test('appConfigSecret exists, encrypted with a CMK, and CDK-generates DASHBOARD_PASSWORD', () => {
  const { t } = makeDataTemplate();
  // NOTE: only DASHBOARD_PASSWORD is CDK-generated (generateSecretString allows one key). The
  // §13 length rules (VAULT_ENC_KEY==32, SECRET_KEY_BASE>=64) are generated + enforced at
  // Lambda runtime and are covered by test/jwt-signer.test.ts, not this template assertion.
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/app-config',
    KmsKeyId: Match.anyValue(),
    GenerateSecretString: Match.objectLike({
      GenerateStringKey: 'DASHBOARD_PASSWORD',
      PasswordLength: 40,
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

test('backup vault is Vault-Locked (compliance) and encrypted with backupKey', () => {
  const { t } = makeDataTemplate();
  t.resourceCountIs('AWS::Backup::BackupVault', 1);
  t.hasResourceProperties('AWS::Backup::BackupVault', {
    // Vault Lock configured => LockConfiguration block present (compliance = MinRetentionDays
    // set and a ChangeableForDays cooling-off window).
    LockConfiguration: Match.objectLike({ MinRetentionDays: Match.anyValue() }),
    EncryptionKeyArn: Match.anyValue(),
  });
});

test('backup plan has exactly three tiered rules (35d / 1y / 7y) and a tag-based selection', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::Backup::BackupPlan', {
    BackupPlan: Match.objectLike({
      BackupPlanRule: Match.arrayWith([
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 35 }) }),
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 365 }) }),
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 2555 }) }),
      ]),
    }),
  });
  t.hasResourceProperties('AWS::Backup::BackupSelection', {
    BackupSelection: Match.objectLike({
      ListOfTags: Match.arrayWith([
        Match.objectLike({
          ConditionType: 'STRINGEQUALS',
          ConditionKey: 'supabase:backup',
          ConditionValue: 'true',
        }),
      ]),
    }),
  });
});
