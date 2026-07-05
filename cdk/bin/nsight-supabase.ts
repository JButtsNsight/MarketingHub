#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

// Stacks are wired in Task 6.

app.synth();
