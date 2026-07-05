import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface DataStackProps extends StackProps {
  readonly dataKey: kms.IKey;
  readonly backupKey: kms.IKey;
  readonly secretsKey: kms.IKey;
}

export class DataStack extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;

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
  }
}
