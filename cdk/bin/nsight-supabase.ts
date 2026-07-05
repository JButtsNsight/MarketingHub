#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

const foundation = new FoundationStack(app, 'SupabaseFoundation', { env });
const network = new NetworkStack(app, 'SupabaseNetwork', { env, logsKey: foundation.logsKey });
const data = new DataStack(app, 'SupabaseData', {
  env,
  dataKey: foundation.dataKey,
  backupKey: foundation.backupKey,
  secretsKey: foundation.secretsKey,
});

const compute = new ComputeStack(app, 'SupabaseCompute', {
  env,
  vpc: network.vpc,
  ec2Sg: network.ec2Sg,
  dataKey: foundation.dataKey,
  storageBucket: data.storageBucket,
  backupBucket: data.backupBucket,
  appConfigSecret: data.appConfigSecret,
  serviceRoleSecret: data.serviceRoleSecret,
  storageCredsSecret: data.storageCredsSecret,
  smtpSecret: data.smtpSecret,
});

new EdgeStack(app, 'SupabaseEdge', {
  env,
  vpc: network.vpc,
  albSg: network.albSg,
  internalClientSg: network.internalClientSg,
  instance: compute.instance,
});

app.synth();
