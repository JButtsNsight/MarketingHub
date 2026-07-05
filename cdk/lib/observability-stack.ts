import { Stack, StackProps, Duration, RemovalPolicy } from 'aws-cdk-lib';
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
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDest from 'aws-cdk-lib/aws-logs-destinations';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';

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
    // Audit-adjacent alerting infra — never auto-delete (Conventions / HIPAA). Losing
    // the topic silently drops the confirmed on-call subscription and disables paging.
    this.topic.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.topic.addSubscription(new subs.EmailSubscription(oncallEmail));

    // The topic is SSE-encrypted under logsKey (reused per plan §14/§15). For a service
    // to publish to a CMK-encrypted topic, SNS calls kms:GenerateDataKey on the CMK on
    // that service's behalf, so the CMK key policy MUST authorize each publishing
    // principal or the publish fails with KMS AccessDenied and the notification is
    // SILENTLY dropped — on-call is never paged. Grant the CloudWatch-alarm,
    // EventBridge, and Budgets principals use of the key. (CDK's SnsAction / Budget do
    // NOT add these grants; only EventBridge's SnsTopic target does.)
    props.logsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowSupabaseAlertPublishersToUseLogsKey',
      principals: [
        new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
        new iam.ServicePrincipal('events.amazonaws.com'),
        new iam.ServicePrincipal('budgets.amazonaws.com'),
      ],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));

    // AWS Budgets validates at create time that the target SNS topic's resource policy
    // grants budgets.amazonaws.com sns:Publish; CfnBudget does not add it, so without
    // this the Budget resource fails to create and the stack rolls back. Scoped to this
    // account's budget by SourceAccount + SourceArn.
    this.topic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsToPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.topic.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: {
          'aws:SourceArn': `arn:aws:budgets::${this.account}:budget/supabase-monthly-cost`,
        },
      },
    }));

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

    // Replication-slot lag: a stuck Realtime slot silently retains WAL and fills
    // the disk. A scheduled Lambda inside the VPC (behind internalClientSg, reaching
    // Supavisor :5432) queries pg_replication_slots and publishes the max retained-WAL
    // bytes as a custom metric; the alarm below notifies on-call.
    const dbSecretArn =
      (this.node.tryGetContext('dbSecretArn') as string) ?? 'REPLACE_WITH_DB_SECRET_ARN';

    const slotLagFn = new lambda.Function(this, 'SlotLagFn', {
      functionName: 'supabase-replication-slot-lag',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'assets', 'slot-lag-lambda'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.internalClientSg], // reaches Supavisor :5432 per NetworkStack §6 rules
      environment: {
        DB_SECRET_ARN: dbSecretArn,
      },
    });
    // Least privilege: put ONLY the one custom metric (namespace-scoped; PutMetricData
    // has no resource-level ARN, so the namespace condition is the tightest scope) ...
    slotLagFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'Supabase/DB' } },
    }));
    // ... and read ONLY the DB secret (exact ARN — never "*").
    slotLagFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [dbSecretArn],
    }));

    const slotSchedule = new events.Rule(this, 'SlotLagSchedule', {
      ruleName: 'supabase-slot-lag-schedule',
      schedule: events.Schedule.rate(Duration.minutes(5)),
    });
    slotSchedule.addTarget(new targets.LambdaFunction(slotLagFn));

    // ~1 GiB retained WAL = investigate before the disk fills. No data = Lambda broken
    // = fail loud (treatMissingData BREACHING).
    const slotLagAlarm = new cw.Alarm(this, 'SlotLagAlarm', {
      alarmName: 'supabase-replication-slot-retained-wal-high',
      metric: new cw.Metric({
        namespace: 'Supabase/DB',
        metricName: 'MaxSlotRetainedWALBytes',
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1_073_741_824, // 1 GiB
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    slotLagAlarm.addAlarmAction(action);

    // Postgres reachability — synthetic check (spec §16). The slot-lag Lambda connects
    // to Postgres via Supavisor every 5 min and publishes PostgresUp=1 only on a
    // successful connect+query; if Postgres is unreachable (or the Lambda errors) no
    // datapoint is published, so LessThanThreshold(1) + treatMissingData BREACHING
    // catches a dead db container on a still-"healthy" host — the §16 blind spot.
    const pgReachabilityAlarm = new cw.Alarm(this, 'PostgresReachabilityAlarm', {
      alarmName: 'supabase-postgres-unreachable',
      metric: new cw.Metric({
        namespace: 'Supabase/DB',
        metricName: 'PostgresUp',
        statistic: 'Minimum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    pgReachabilityAlarm.addAlarmAction(action);

    // Connection saturation (spec §16): the same Lambda publishes used/max_connections
    // as a percentage. >=80% sustained means the pool is exhausting.
    const connSaturationAlarm = new cw.Alarm(this, 'ConnectionSaturationAlarm', {
      alarmName: 'supabase-connection-saturation',
      metric: new cw.Metric({
        namespace: 'Supabase/DB',
        metricName: 'ConnectionUtilizationPercent',
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    connSaturationAlarm.addAlarmAction(action);

    // Container down / unhealthy (spec §16): ASG-style instance health is blind to a
    // dead `db`/kong/auth container on a live host. A host cron (cdk/assets/
    // container-health.sh, scheduled by Phase 3's bootstrap alongside the CloudWatch
    // agent) publishes UnhealthyContainerCount = count of non-running/unhealthy compose
    // containers. treatMissingData BREACHING makes a missing emitter fail LOUD (same
    // pattern as the disk alarms), never silent.
    const containerHealthAlarm = new cw.Alarm(this, 'ContainerHealthAlarm', {
      alarmName: 'supabase-container-unhealthy',
      metric: new cw.Metric({
        namespace: 'Supabase/Containers',
        metricName: 'UnhealthyContainerCount',
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    containerHealthAlarm.addAlarmAction(action);

    // pgBackRest is the PRIMARY, minute-RPO backup tier (spec §9); AWS Backup snapshots
    // are secondary. AWS Backup failures are caught by the EventBridge rule above, but
    // pgBackRest failures emit NO AWS Backup event. The host pgBackRest cron
    // (cdk/assets/pgbackrest-cron) publishes PgBackRestJobFailed=1 on any failure (and
    // 0 on success so the alarm can clear); alarm on it so a silent WAL-archiving /
    // backup failure on the primary tier is detected before the next restore drill.
    const pgBackRestAlarm = new cw.Alarm(this, 'PgBackRestFailureAlarm', {
      alarmName: 'supabase-pgbackrest-job-failed',
      metric: new cw.Metric({
        namespace: 'Supabase/Backup',
        metricName: 'PgBackRestJobFailed',
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    pgBackRestAlarm.addAlarmAction(action);

    // Monthly cost guardrail (spec §16/§25). Amount from context, never hardcoded.
    const budgetAmount = Number(this.node.tryGetContext('monthlyBudgetUsd'));
    if (!Number.isFinite(budgetAmount) || budgetAmount <= 0) {
      throw new Error('ObservabilityStack requires a positive "monthlyBudgetUsd" context value.');
    }

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'supabase-monthly-cost',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetAmount, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'ACTUAL',
            threshold: 80, // percent of budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: oncallEmail },
            { subscriptionType: 'SNS', address: this.topic.topicArn },
          ],
        },
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'FORECASTED',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: oncallEmail }],
        },
      ],
    });

    // CloudTrail S3 data events on the PHI storage + backup buckets (spec §15) — object-level
    // access is otherwise invisible to management-event logging. Encrypted with logsKey; the
    // trail + its own bucket are RETAINed (audit-adjacent — never auto-delete).
    // CloudTrail encrypts its log files under logsKey; the CMK key policy MUST authorize
    // the CloudTrail service principal (kms:GenerateDataKey*/kms:DescribeKey, scoped by
    // the trail-ARN encryption context) or CreateTrail fails with
    // InsufficientEncryptionPolicyException and the whole stack rolls back.
    props.logsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowSupabaseCloudTrailToUseLogsKey',
      principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
      actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        StringLike: {
          'kms:EncryptionContext:aws:cloudtrail:arn':
            `arn:aws:cloudtrail:${this.region}:${this.account}:trail/*`,
        },
      },
    }));

    // Explicit, hardened delivery bucket (the construct's auto-created bucket sets only
    // enforceSSL — no Block Public Access, no default encryption — on records that expose
    // PHI object keys/access patterns). Match the LogArchiveBucket hardening.
    const trailBucket = new s3.Bucket(this, 'PhiDataTrailBucket', {
      bucketName: `nsight-supabase-phi-trail-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.logsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const trail = new cloudtrail.Trail(this, 'PhiDataTrail', {
      trailName: 'supabase-phi-data-events',
      bucket: trailBucket,
      encryptionKey: props.logsKey,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false, // single-region stack (spec §5)
    });
    trail.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Object-level data events on the PHI buckets ONLY (not all-S3 — cost + noise).
    trail.addS3EventSelector(
      [
        { bucket: props.storageBucket },
        { bucket: props.backupBucket },
      ],
      {
        readWriteType: cloudtrail.ReadWriteType.ALL,
        includeManagementEvents: true,
      },
    );

    // --- Log tiering (spec §15): short-retention operational CW group + a 7-yr,
    // Object-Locked, Glacier-tiered S3 archive fed by a subscription filter. ---

    // 7-year compliance archive: Object-Locked, Glacier-tiered, KMS-encrypted, retained.
    const archiveBucket = new s3.Bucket(this, 'LogArchiveBucket', {
      bucketName: `nsight-supabase-log-archive-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.logsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(2557)), // 7 yr
      lifecycleRules: [
        {
          id: 'to-glacier-then-retain-7yr',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
          expiration: Duration.days(2557),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Operational log group with SHORT retention (spec §15: 30–90 d for operability).
    const opsLogGroup = new logs.LogGroup(this, 'SupabaseOpsLogGroup', {
      logGroupName: '/nsight/supabase/app',
      retention: logs.RetentionDays.THREE_MONTHS, // 90 days
      encryptionKey: props.logsKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Firehose → S3 archive (the durable long-term tier).
    const archiveStream = new firehose.DeliveryStream(this, 'LogArchiveStream', {
      destination: new firehose.S3Bucket(archiveBucket, {
        dataOutputPrefix: 'cw-logs/!{timestamp:yyyy/MM/dd}/',
        errorOutputPrefix: 'cw-logs-errors/!{firehose:error-output-type}/!{timestamp:yyyy/MM/dd}/',
        bufferingInterval: Duration.minutes(5),
        encryptionKey: props.logsKey,
      }),
    });

    // Subscription filter: everything in the ops group flows to the archive.
    new logs.SubscriptionFilter(this, 'OpsToArchive', {
      logGroup: opsLogGroup,
      destination: new logsDest.FirehoseDestination(archiveStream),
      filterPattern: logs.FilterPattern.allEvents(),
    });
  }
}
