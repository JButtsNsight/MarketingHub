#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

// Same previewMode semantics as AppStack: boolean true in cdk.json context or
// the string 'true' from `-c previewMode=true`; anything else is production.
const previewCtx = app.node.tryGetContext('previewMode');
const preview = previewCtx === true || previewCtx === 'true';

// CloudFormation STACK tags (StackProps.tags — the CLI passes these on every
// deploy, and CloudFormation propagates them to supported resources). These
// mirror the tags applied to the deployed stack out-of-band on 2026-07-14 so
// the next `cdk deploy` preserves rather than strips them.
const stackTags = {
  Environment: preview ? 'preview' : 'production',
  Project: 'marketinghub',
  Owner: 'jbutts@nsightcare.com',
  ManagedBy: 'cdk',
  DataClassification: 'phi',
};

new AppStack(app, 'MarketingHubApp', { env, tags: stackTags });

app.synth();
