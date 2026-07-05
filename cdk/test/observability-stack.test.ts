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
