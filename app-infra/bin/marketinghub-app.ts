#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

new AppStack(app, 'MarketingHubApp', { env });

app.synth();
