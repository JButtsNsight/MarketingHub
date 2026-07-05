import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
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
  }
}
