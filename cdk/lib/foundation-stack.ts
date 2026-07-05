import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';

export class FoundationStack extends Stack {
  public readonly dataKey: kms.Key;
  public readonly backupKey: kms.Key;
  public readonly logsKey: kms.Key;
  public readonly secretsKey: kms.Key;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const mkKey = (logicalId: string, alias: string, description: string) =>
      new kms.Key(this, logicalId, {
        alias,
        description,
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.dataKey = mkKey('DataKey', 'alias/nsight-supabase-data',
      'CMK for EBS volumes and the S3 storage bucket');
    this.backupKey = mkKey('BackupKey', 'alias/nsight-supabase-backup',
      'CMK for AWS Backup vault and pgBackRest/pg_dump S3 backups');
    this.logsKey = mkKey('LogsKey', 'alias/nsight-supabase-logs',
      'CMK for CloudWatch log groups and VPC flow logs');
    this.secretsKey = mkKey('SecretsKey', 'alias/nsight-supabase-secrets',
      'CMK for Secrets Manager secrets');

    // Scoped grant so the CloudWatch Logs service can use the logs CMK to
    // encrypt log groups / flow logs. Constrained by encryption context to
    // this account's log groups only — not a blanket kms:*.
    this.logsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: [
        'kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*',
        'kms:GenerateDataKey*', 'kms:Describe*',
      ],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn':
            `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        },
      },
    }));
  }
}
