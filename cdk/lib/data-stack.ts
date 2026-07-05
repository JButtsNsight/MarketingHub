import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

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
  }
}
