import { Stack, StackProps, RemovalPolicy, Duration, CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as path from 'path';

export interface DataStackProps extends StackProps {
  readonly dataKey: kms.IKey;
  readonly backupKey: kms.IKey;
  readonly secretsKey: kms.IKey;
}

export class DataStack extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly serviceRoleKey: kms.Key;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly appConfigSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // §10/§14 — Supabase Storage S3 backend. PHI-bearing objects.
    this.storageBucket = new s3.Bucket(this, 'StorageBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // §9/§14 — pgBackRest WAL/base backups + nightly pg_dump. 7-yr tier via Glacier.
    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.backupKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
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
    });

    // §12 — crown-jewel key segregation. service_role gets its OWN CMK,
    // separate from Foundation's secretsKey used for everything else.
    this.serviceRoleKey = new kms.Key(this, 'ServiceRoleKey', {
      alias: 'alias/nsight-supabase-service-role',
      description: 'Dedicated CMK for the service_role (BYPASSRLS) crown-jewel secret',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Placeholder value; the real signed SERVICE_ROLE_KEY JWT is written by the
    // custom resource in Task 4 (never distributed to app clients — §12).
    this.serviceRoleSecret = new secretsmanager.Secret(this, 'ServiceRoleSecret', {
      secretName: 'nsight-supabase/service-role',
      description: 'Supabase service_role JWT (BYPASSRLS). Crown jewel — server-side/admin only.',
      encryptionKey: this.serviceRoleKey,
      secretObjectValue: {}, // populated at deploy time by JwtSigner custom resource
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
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
  }
}
