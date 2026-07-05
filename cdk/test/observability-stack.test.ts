import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const env = { account: '439024109088', region: 'us-east-1' };
const context = { oncallEmail: 'oncall@nsightcare.com', monthlyBudgetUsd: 550 };

export function makeStack(): { t: Template; stack: ObservabilityStack; foundation: FoundationStack } {
  const app = new App({ context });
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  const data = new DataStack(app, 'Data', {
    env,
    dataKey: foundation.dataKey,
    backupKey: foundation.backupKey,
    secretsKey: foundation.secretsKey,
  });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    vpc: network.vpc,
    ec2Sg: network.ec2Sg,
    dataKey: foundation.dataKey,
    backupBucket: data.backupBucket,
    storageBucket: data.storageBucket,
    appConfigSecret: data.appConfigSecret,
    serviceRoleSecret: data.serviceRoleSecret,
    storageCredsSecret: data.storageCredsSecret,
    smtpSecret: data.smtpSecret,
  });
  const stack = new ObservabilityStack(app, 'Observability', {
    env,
    instance: compute.instance,
    backupVault: data.backupVault,
    logsKey: foundation.logsKey,
    vpc: network.vpc,
    internalClientSg: network.internalClientSg,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
  });
  return { t: Template.fromStack(stack), stack, foundation };
}

test('ObservabilityStack synthesizes', () => {
  const { t } = makeStack();
  expect(t).toBeDefined();
});

test('KMS-encrypted SNS topic with an email subscription from context', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::SNS::Topic', 1);
  t.hasResourceProperties('AWS::SNS::Topic', {
    KmsMasterKeyId: Match.anyValue(), // encrypted with logsKey
  });
  t.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'oncall@nsightcare.com',
  });
});

test('on-call SNS topic is RETAINed (HIPAA audit-adjacent infra)', () => {
  const { t } = makeStack();
  t.hasResource('AWS::SNS::Topic', { DeletionPolicy: 'Retain' });
});

test('the logs CMK authorizes the alert publishers and CloudTrail (SSE delivery)', () => {
  const { foundation } = makeStack();
  const ft = Template.fromStack(foundation);
  // CloudWatch alarms / EventBridge / Budgets must be able to SSE-encrypt when
  // publishing to the KMS-encrypted on-call topic, or notifications are dropped.
  ft.hasResourceProperties('AWS::KMS::Key', {
    KeyPolicy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: Match.objectLike({
            Service: Match.arrayWith([
              'cloudwatch.amazonaws.com',
              'budgets.amazonaws.com',
            ]),
          }),
          Action: Match.arrayWith(['kms:Decrypt', 'kms:GenerateDataKey*']),
        }),
      ]),
    }),
  });
  // CloudTrail must be able to encrypt log files under the same CMK, or the
  // trail fails to create (InsufficientEncryptionPolicyException).
  ft.hasResourceProperties('AWS::KMS::Key', {
    KeyPolicy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'cloudtrail.amazonaws.com' },
          Action: Match.arrayWith(['kms:GenerateDataKey*', 'kms:DescribeKey']),
        }),
      ]),
    }),
  });
});

test('the on-call topic policy lets AWS Budgets publish to it', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::SNS::TopicPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'budgets.amazonaws.com' },
          Action: 'sns:Publish',
        }),
      ]),
    }),
  });
});

test('at least three alarms are wired to the SNS topic', () => {
  const { t } = makeStack();
  // status-check + CPU + root-disk + data-disk + slot-lag + pgBackRest-failure
  // + Postgres-reachability + connection-saturation + container-health = 9
  t.resourceCountIs('AWS::CloudWatch::Alarm', 9);
  // every alarm actions the on-call topic
  const alarms = t.findResources('AWS::CloudWatch::Alarm');
  const topicRef = Object.keys(t.findResources('AWS::SNS::Topic'))[0];
  for (const alarm of Object.values(alarms)) {
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain(topicRef);
  }
});

test('instance status-check and CPU alarms use EC2 metrics', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'StatusCheckFailed_Instance',
    Namespace: 'AWS/EC2',
  });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'CPUUtilization',
    Namespace: 'AWS/EC2',
  });
});

test('root and data disk alarms use the CWAgent disk_used_percent metric at 80%', () => {
  const { t } = makeStack();
  const diskAlarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'))
    .filter((a) => a.Properties.MetricName === 'disk_used_percent');
  expect(diskAlarms.length).toBe(2);
  for (const a of diskAlarms) {
    expect(a.Properties.Namespace).toBe('CWAgent');
    expect(a.Properties.Threshold).toBe(80);
  }
});

test('EventBridge rule on Backup Job FAILED targets the SNS topic', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.backup'],
      'detail-type': ['Backup Job State Change'],
      detail: { state: ['FAILED'] },
    },
    Targets: Match.arrayWith([
      Match.objectLike({ Arn: Match.anyValue() }),
    ]),
  });
});

test('scheduled Lambda in the VPC monitors replication-slot lag', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: Match.stringLikeRegexp('^python3'),
    VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
  });
  // scheduled every 5 minutes
  t.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(5 minutes)',
  });
});

test('alarm on the replication-slot retained-WAL custom metric', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'MaxSlotRetainedWALBytes',
    Namespace: 'Supabase/DB',
  });
});

test('alarm on pgBackRest (primary backup tier) job failures', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'PgBackRestJobFailed',
    Namespace: 'Supabase/Backup',
  });
});

test('alarm on Postgres reachability (synthetic check, fail-loud on missing data)', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'PostgresUp',
    Namespace: 'Supabase/DB',
    ComparisonOperator: 'LessThanThreshold',
    TreatMissingData: 'breaching',
  });
});

test('alarm on Postgres connection saturation', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'ConnectionUtilizationPercent',
    Namespace: 'Supabase/DB',
  });
});

test('alarm on container down / unhealthy (fail-loud on missing data)', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'UnhealthyContainerCount',
    Namespace: 'Supabase/Containers',
    TreatMissingData: 'breaching',
  });
});

test('monthly cost budget at the context amount with SNS + email notification', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: Match.objectLike({
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 550, Unit: 'USD' },
    }),
    NotificationsWithSubscribers: Match.arrayWith([
      Match.objectLike({
        Notification: Match.objectLike({
          ComparisonOperator: 'GREATER_THAN',
          NotificationType: 'ACTUAL',
        }),
        Subscribers: Match.arrayWith([
          Match.objectLike({ SubscriptionType: 'EMAIL', Address: 'oncall@nsightcare.com' }),
        ]),
      }),
    ]),
  });
});

test('CloudTrail trail records S3 data events on the PHI buckets', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::CloudTrail::Trail', 1);
  t.hasResourceProperties('AWS::CloudTrail::Trail', {
    EventSelectors: Match.arrayWith([
      Match.objectLike({
        DataResources: Match.arrayWith([
          Match.objectLike({ Type: 'AWS::S3::Object' }),
        ]),
      }),
    ]),
  });
});

test('CloudTrail log bucket blocks all public access (PHI audit records)', () => {
  const { t } = makeStack();
  // Both the trail bucket and the archive bucket must block public access.
  const buckets = Object.values(t.findResources('AWS::S3::Bucket'));
  expect(buckets.length).toBeGreaterThanOrEqual(2);
  for (const b of buckets) {
    expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  }
});

test('operational log group has short (90-day) retention', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Logs::LogGroup', {
    RetentionInDays: 90,
  });
});

test('7-year archive bucket has Object Lock and a Glacier lifecycle transition', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([
        Match.objectLike({
          Transitions: Match.arrayWith([
            Match.objectLike({ StorageClass: 'GLACIER' }),
          ]),
        }),
      ]),
    }),
  });
});

test('a subscription filter ships the log group to the archive', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::Logs::SubscriptionFilter', 1);
});
