import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface ObservabilityStackProps extends StackProps {
  readonly instance: ec2.Instance;
  readonly backupVault: backup.BackupVault;
  readonly logsKey: kms.IKey;
  readonly vpc: ec2.IVpc;
  readonly internalClientSg: ec2.ISecurityGroup;
  readonly storageBucket: s3.IBucket;
  readonly backupBucket: s3.IBucket;
}

export class ObservabilityStack extends Stack {
  public readonly topic!: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    // Constructs are added in Tasks 1–9.
    void props;
  }
}
