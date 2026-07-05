#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

const foundation = new FoundationStack(app, 'SupabaseFoundation', { env });
new NetworkStack(app, 'SupabaseNetwork', { env, logsKey: foundation.logsKey });
new DataStack(app, 'SupabaseData', {
  env,
  dataKey: foundation.dataKey,
  backupKey: foundation.backupKey,
  secretsKey: foundation.secretsKey,
});

app.synth();
