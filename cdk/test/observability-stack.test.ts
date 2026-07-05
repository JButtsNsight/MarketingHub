import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const env = { account: '439024109088', region: 'us-east-1' };
const context = { oncallEmail: 'oncall@nsightcare.com', monthlyBudgetUsd: 550 };

export function makeStack(): { t: Template; stack: ObservabilityStack } {
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
  return { t: Template.fromStack(stack), stack };
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

test('at least three alarms are wired to the SNS topic', () => {
  const { t } = makeStack();
  // status-check + CPU + root-disk + data-disk = 4
  t.resourceCountIs('AWS::CloudWatch::Alarm', 4);
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
