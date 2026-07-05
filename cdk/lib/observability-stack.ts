import { Stack, StackProps, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

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

    const oncallEmail = this.node.tryGetContext('oncallEmail') as string;
    if (!oncallEmail) {
      throw new Error('ObservabilityStack requires the "oncallEmail" context value.');
    }

    (this as { topic: sns.Topic }).topic = new sns.Topic(this, 'OnCallTopic', {
      displayName: 'Supabase on-call alerts',
      masterKey: props.logsKey,
    });
    this.topic.addSubscription(new subs.EmailSubscription(oncallEmail));

    const action = new cwActions.SnsAction(this.topic);

    // (a) Instance-level status check (distinct from the System check used for
    // auto-recovery in Phase 3's ComputeStack).
    const statusCheck = new cw.Alarm(this, 'InstanceStatusCheckAlarm', {
      alarmName: 'supabase-instance-status-check-failed',
      metric: new cw.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_Instance',
        dimensionsMap: { InstanceId: props.instance.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    statusCheck.addAlarmAction(action);

    // (b) CPU high.
    const cpuHigh = new cw.Alarm(this, 'CpuHighAlarm', {
      alarmName: 'supabase-cpu-high',
      metric: new cw.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: { InstanceId: props.instance.instanceId },
        statistic: 'Average',
        period: Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    cpuHigh.addAlarmAction(action);

    // (c) disk_used_percent >= 80% on BOTH filesystems (CWAgent namespace). The
    // CWAgent metric only exists if Phase 3's ComputeStack bootstrap installs the
    // CloudWatch agent with cdk/assets/cwagent-config.json — treatMissingData:
    // BREACHING makes a missing agent / mismatched dimension fail LOUD, not silent.
    const diskAlarm = (id: string, path: string, device: string, fstype: string) => {
      const a = new cw.Alarm(this, id, {
        alarmName: `supabase-disk-full-${id}`,
        metric: new cw.Metric({
          namespace: 'CWAgent',
          metricName: 'disk_used_percent',
          dimensionsMap: {
            InstanceId: props.instance.instanceId,
            path,
            device,
            fstype,
          },
          statistic: 'Maximum',
          period: Duration.minutes(5),
        }),
        threshold: 80,
        evaluationPeriods: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.BREACHING,
      });
      a.addAlarmAction(action);
      return a;
    };
    // device/fstype are the Amazon Linux 2023 Nitro defaults; reconcile the `path`
    // values with cwagent-config.json and the live metric dimensions (Task 11).
    diskAlarm('RootDiskAlarm', '/', 'nvme0n1p1', 'xfs');
    diskAlarm('DataDiskAlarm', '/mnt/pgdata', 'nvme1n1', 'xfs');

    // Backup-failure detection: silent AWS Backup failures are otherwise invisible.
    // Scoped to the Supabase vault (spec §9) so the alert is specific.
    const backupFailureRule = new events.Rule(this, 'BackupJobFailedRule', {
      ruleName: 'supabase-backup-job-failed',
      description: 'Fires when an AWS Backup job for the Supabase vault fails.',
      eventPattern: {
        source: ['aws.backup'],
        detailType: ['Backup Job State Change'],
        detail: {
          state: ['FAILED'],
          backupVaultName: [props.backupVault.backupVaultName],
        },
      },
    });
    backupFailureRule.addTarget(new targets.SnsTopic(this.topic));
  }
}
