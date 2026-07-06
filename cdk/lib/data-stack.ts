import { Stack, StackProps, RemovalPolicy, Duration, CustomResource, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as path from 'path';

export interface DataStackProps extends StackProps {
  readonly dataKey: kms.IKey;
  readonly backupKey: kms.IKey;
  readonly secretsKey: kms.IKey;
  // Tear-downable "preview" profile (default false). When true: buckets drop Object
  // Lock and become fully deletable (DESTROY + autoDeleteObjects), the AWS Backup
  // vault/plan/selection are skipped entirely, and every secret + the service-role CMK
  // use a DESTROY removal policy. SSE-KMS, blockPublicAccess, enforceSSL, versioning,
  // the JWT-signer, and all secret generation are unchanged. Production keeps RETAIN
  // + COMPLIANCE Object Lock + the Vault-Locked backup tier.
  readonly preview?: boolean;
}

export class DataStack extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly serviceRoleKey: kms.Key;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly appConfigSecret: secretsmanager.Secret;
  public readonly storageCredsSecret: secretsmanager.Secret;
  public readonly smtpSecret: secretsmanager.Secret;
  // Skipped entirely in preview (no AWS Backup at all) — hence the definite-assignment
  // assertion. Only the production (compliance) path and ObservabilityStack use it, and
  // ObservabilityStack is not instantiated in preview.
  public readonly backupVault!: backup.BackupVault;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // Preview = tear-downable: no irreversible locks, everything deletable.
    const preview = props.preview === true;
    const retainOrDestroy = preview ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // §10/§14 — Supabase Storage S3 backend. PHI-bearing objects.
    // Object Lock cannot be enabled on a bucket we intend to delete, so preview OMITS it
    // (and its COMPLIANCE default retention + the 7-yr noncurrent lifecycle) and instead
    // makes the bucket fully deletable (DESTROY + autoDeleteObjects). SSE-KMS(+dataKey),
    // blockPublicAccess ALL, enforceSSL, and versioning are kept in both modes.
    this.storageBucket = new s3.Bucket(this, 'StorageBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      ...(preview
        ? {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
          }
        : {
            objectLockEnabled: true,
            // §10 — Object Lock is inert without a retention: storage-api PutObject sends no
            // per-object retention header, so a bucket-level COMPLIANCE default is what actually
            // makes each object version WORM. 2555 d (7 yr) so objects can't be hard-deleted out
            // from under a DB restore, even by a privileged/root principal (§164.312(c)).
            objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(2555)),
            lifecycleRules: [
              {
                id: 'storage-noncurrent-7yr',
                enabled: true,
                // Live (current) PHI objects stay in Standard so the app can read them; superseded
                // (noncurrent) versions tier to Glacier and expire at the 7-yr window (§10). They
                // can never expire early anyway — COMPLIANCE Object Lock pins each version 2555 d.
                noncurrentVersionTransitions: [
                  { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(30) },
                ],
                noncurrentVersionExpiration: Duration.days(2555),
              },
            ],
            removalPolicy: RemovalPolicy.RETAIN,
          }),
    });

    // §9/§14 — pgBackRest WAL/base backups + nightly pg_dump. 7-yr tier via Glacier.
    // Preview OMITS Object Lock (can't delete a locked bucket) and its lifecycle, and
    // makes the bucket fully deletable (DESTROY + autoDeleteObjects). SSE-KMS(+backupKey),
    // blockPublicAccess ALL, enforceSSL, and versioning are kept in both modes.
    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.backupKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      ...(preview
        ? {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
          }
        : {
            objectLockEnabled: true,
            // Compliance-mode default retention aligned to the 7-yr window (§9/§10).
            objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(2555)),
            lifecycleRules: [
              {
                id: 'backup-to-glacier-7yr',
                enabled: true,
                // Current objects age into Glacier; older WAL/base backups don't sit in Standard.
                transitions: [
                  { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(30) },
                ],
                // Noncurrent versions likewise tier down, then expire at the 7-yr window.
                noncurrentVersionTransitions: [
                  { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(30) },
                ],
                noncurrentVersionExpiration: Duration.days(2555),
              },
            ],
            removalPolicy: RemovalPolicy.RETAIN,
          }),
    });

    // §14 — require SSE-KMS with the *specific* CMK on upload. Default bucket encryption only
    // applies when the request omits an encryption header; it does NOT stop a writer that
    // explicitly overrides it (e.g. `x-amz-server-side-encryption: AES256`, which needs no KMS
    // permission) from landing PHI outside the segregated data/backup CMK. These Deny
    // statements close that hole while leaving the normal header-less path (default CMK) intact.
    const requireSseKms = (bucket: s3.Bucket, key: kms.IKey) => {
      // Deny an explicit non-aws:kms scheme (IfExists → header-less requests still fall through
      // to bucket default encryption with the CMK).
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyNonKmsEncryption',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: {
          StringNotEqualsIfExists: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
      }));
      // Deny an explicit KMS key that isn't this bucket's segregated CMK (IfExists → requests
      // that don't name a key use the bucket default CMK).
      bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'DenyWrongKmsKey',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [`${bucket.bucketArn}/*`],
        conditions: {
          StringNotEqualsIfExists: { 's3:x-amz-server-side-encryption-aws-kms-key-id': key.keyArn },
        },
      }));
    };
    requireSseKms(this.storageBucket, props.dataKey);
    requireSseKms(this.backupBucket, props.backupKey);

    // §12 — crown-jewel key segregation. service_role gets its OWN CMK,
    // separate from Foundation's secretsKey used for everything else.
    this.serviceRoleKey = new kms.Key(this, 'ServiceRoleKey', {
      alias: 'alias/nsight-supabase-service-role',
      description: 'Dedicated CMK for the service_role (BYPASSRLS) crown-jewel secret',
      enableKeyRotation: true,
      removalPolicy: retainOrDestroy,
      // §14 — segregated key policy: key admins ≠ usage principals, and NO unconditioned
      // kms:*-to-root. Replacing the default policy means an over-scoped IAM/break-glass role
      // holding a broad kms:Decrypt can no longer decrypt the crown-jewel data key directly:
      // usage is delegated to IAM only through Secrets Manager (kms:ViaService), which is where
      // the service_role secret's envelope key is legitimately exercised (§12).
      policy: new iam.PolicyDocument({
        statements: [
          // Administration only (no en/decrypt) — keeps the key manageable by the account.
          new iam.PolicyStatement({
            sid: 'KeyAdministration',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              'kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*',
              'kms:Update*', 'kms:Revoke*', 'kms:Disable*', 'kms:Get*', 'kms:Delete*',
              'kms:TagResource', 'kms:UntagResource',
              'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion',
            ],
            resources: ['*'],
          }),
          // Crypto usage delegated to IAM, but ONLY via Secrets Manager — deny otherwise.
          new iam.PolicyStatement({
            sid: 'UsageViaSecretsManagerOnly',
            effect: iam.Effect.ALLOW,
            principals: [new iam.AccountRootPrincipal()],
            actions: [
              'kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*',
              'kms:GenerateDataKey*', 'kms:DescribeKey',
            ],
            resources: ['*'],
            conditions: {
              StringEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` },
            },
          }),
        ],
      }),
    });

    // Placeholder value; the real signed SERVICE_ROLE_KEY JWT is written by the
    // custom resource in Task 4 (never distributed to app clients — §12).
    this.serviceRoleSecret = new secretsmanager.Secret(this, 'ServiceRoleSecret', {
      secretName: 'nsight-supabase/service-role',
      description: 'Supabase service_role JWT (BYPASSRLS). Crown jewel — server-side/admin only.',
      encryptionKey: this.serviceRoleKey,
      secretObjectValue: {}, // populated at deploy time by JwtSigner custom resource
      removalPolicy: retainOrDestroy,
    });

    // §13 — non-crown-jewel compose config. A single secretsmanager.Secret can only
    // auto-generate ONE string key (here DASHBOARD_PASSWORD). The signer Lambda below
    // generates every other random under exact length rules (VAULT_ENC_KEY==32,
    // SECRET_KEY_BASE>=64, etc.) and merges them in the same PutSecretValue that writes
    // the signed JWT fields — so no secret is ever a static literal or emitted to logs.
    this.appConfigSecret = new secretsmanager.Secret(this, 'AppConfigSecret', {
      secretName: 'nsight-supabase/app-config',
      description:
        'Supabase compose config: POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SECRET_KEY_BASE, ' +
        'VAULT_ENC_KEY, PG_META_CRYPTO_KEY, POOLER_TENANT_ID, DASHBOARD_USERNAME/PASSWORD, ' +
        'S3_PROTOCOL_ACCESS_KEY_ID/SECRET. JWT fields signed by the JwtSigner custom resource.',
      encryptionKey: props.secretsKey,
      generateSecretString: {
        // Seed the JSON with the dashboard username literal; generate DASHBOARD_PASSWORD.
        secretStringTemplate: JSON.stringify({ DASHBOARD_USERNAME: 'supabase_admin' }),
        generateStringKey: 'DASHBOARD_PASSWORD',
        passwordLength: 40,
        excludePunctuation: true,
      },
      removalPolicy: retainOrDestroy,
    });

    // §12/§13 — deploy-time signer. Generates JWT_SECRET, signs ANON_KEY (→ app-config)
    // and SERVICE_ROLE_KEY (→ service-role secret), and fills the remaining randoms.
    const signerFn = new lambda.Function(this, 'JwtSignerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'jwt-signer')),
      timeout: Duration.minutes(2),
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });

    // Least privilege: read+write ONLY the two secrets, decrypt ONLY the two CMKs.
    // Grants are expressed as identity-policy statements on the Lambda role (referencing
    // the exact secret/key ARNs) rather than resource-policy mutations. The keys live in
    // FoundationStack; adding the Lambda role to a Foundation key's *resource* policy would
    // make Foundation depend on Data (Data already depends on Foundation via encryptionKey
    // references) — a stack dependency cycle. Identity-policy grants keep a single Data →
    // Foundation edge. The keys' default policy trusts account IAM identities, so an
    // identity-scoped grant to a specific key ARN is sufficient and least-privilege.
    signerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [this.appConfigSecret.secretArn, this.serviceRoleSecret.secretArn],
    }));
    signerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: [props.secretsKey.keyArn, this.serviceRoleKey.keyArn],
    }));

    const signerProvider = new Provider(this, 'JwtSignerProvider', {
      onEventHandler: signerFn,
    });

    const jwtSigner = new CustomResource(this, 'JwtSigner', {
      serviceToken: signerProvider.serviceToken,
      properties: {
        AppConfigSecretArn: this.appConfigSecret.secretArn,
        ServiceRoleSecretArn: this.serviceRoleSecret.secretArn,
      },
    });
    // Ensure both secrets (and their generated values) exist before the signer runs.
    jwtSigner.node.addDependency(this.appConfigSecret);
    jwtSigner.node.addDependency(this.serviceRoleSecret);

    // §10 — bucket-scoped principal for the Storage container. The ONLY AWS credential
    // reachable from inside a container, and it can touch ONLY this one bucket.
    const storageUser = new iam.User(this, 'StorageUser', {
      userName: 'nsight-supabase-storage',
    });
    storageUser.addToPolicy(new iam.PolicyStatement({
      sid: 'StorageBucketOnly',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject', 's3:PutObject', 's3:DeleteObject',
        's3:ListBucket', 's3:GetBucketLocation',
        's3:AbortMultipartUpload', 's3:ListMultipartUploadParts',
      ],
      resources: [this.storageBucket.bucketArn, `${this.storageBucket.bucketArn}/*`],
    }));
    // Storage must be able to use dataKey to read/write SSE-KMS objects. Expressed as an
    // identity-policy statement on the user (exact key ARN) — a resource-policy grant on
    // the Foundation-owned dataKey would create a Foundation->Data cycle (see signer note).
    storageUser.addToPolicy(new iam.PolicyStatement({
      sid: 'StorageBucketKmsOnly',
      effect: iam.Effect.ALLOW,
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: [props.dataKey.keyArn],
    }));

    const storageAccessKey = new iam.AccessKey(this, 'StorageAccessKey', {
      user: storageUser,
    });

    this.storageCredsSecret = new secretsmanager.Secret(this, 'StorageCredsSecret', {
      secretName: 'nsight-supabase/storage-creds',
      description: 'Bucket-scoped IAM creds for the Supabase Storage container (§10).',
      encryptionKey: props.secretsKey,
      secretObjectValue: {
        AWS_ACCESS_KEY_ID: SecretValue.unsafePlainText(storageAccessKey.accessKeyId),
        AWS_SECRET_ACCESS_KEY: storageAccessKey.secretAccessKey,
      },
      removalPolicy: retainOrDestroy,
    });

    // §13/§20.1 — SES SMTP creds for GoTrue. Shell only; populate AFTER SES production
    // access is granted (sandbox identities silently drop Auth emails). Empty username/
    // password placeholders; update via Secrets Manager once SES is live.
    this.smtpSecret = new secretsmanager.Secret(this, 'SmtpSecret', {
      secretName: 'nsight-supabase/smtp',
      description: 'SES SMTP username/password for GoTrue. Populate post-SES prod access (§20.1).',
      encryptionKey: props.secretsKey,
      secretObjectValue: {
        SMTP_USER: SecretValue.unsafePlainText(''),
        SMTP_PASS: SecretValue.unsafePlainText(''),
      },
      removalPolicy: retainOrDestroy,
    });

    // §9 — AWS Backup (Vault Lock + tiered plan). Skipped ENTIRELY in preview: a
    // Vault-Locked (COMPLIANCE) vault cannot be deleted, which defeats a tear-downable
    // preview, and nothing in preview references the vault (ObservabilityStack — its only
    // other consumer — is not instantiated in preview).
    if (preview) {
      return;
    }

    // §9 — Vault Lock (COMPLIANCE) on a dedicated backupKey-encrypted vault.
    // Setting changeableFor puts the lock into the immutable/compliance regime after the
    // (min 72 h) cooling-off window; minRetention denies early recovery-point deletion.
    this.backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: 'nsight-supabase-backup-vault',
      encryptionKey: props.backupKey,
      removalPolicy: RemovalPolicy.RETAIN,
      lockConfiguration: {
        minRetention: Duration.days(35),
        maxRetention: Duration.days(2555),
        changeableFor: Duration.days(3), // 72 h cooling-off, then COMPLIANCE-immutable
      },
    });

    const plan = new backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: 'nsight-supabase-backup-plan',
      backupVault: this.backupVault,
    });

    // Daily → retain 35 days.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'daily-35d',
      scheduleExpression: events.Schedule.cron({ hour: '5', minute: '0' }),
      deleteAfter: Duration.days(35),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(3),
    }));

    // Weekly (Sundays) → retain 1 year.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'weekly-1y',
      scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '6', minute: '0' }),
      deleteAfter: Duration.days(365),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(6),
    }));

    // Monthly (1st) → retain 7 years (2555 d) — cold tier via moveToColdStorageAfter.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'monthly-7y',
      scheduleExpression: events.Schedule.cron({ day: '1', hour: '7', minute: '0' }),
      deleteAfter: Duration.days(2555),
      moveToColdStorageAfter: Duration.days(90),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(8),
    }));

    // Tag-based selection: everything tagged supabase:backup=true (Phase 3 tags the EBS
    // data volume). Grants a service role scoped to the tagged resources.
    plan.addSelection('TaggedResources', {
      resources: [
        backup.BackupResource.fromTag('supabase:backup', 'true'),
      ],
    });
  }
}
