#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
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

// Stack-level tags (propagate to every taggable resource). These mirror the
// tags applied to the deployed CloudFormation stacks out-of-band on
// 2026-07-14 so the next `cdk deploy` preserves rather than strips them.
Tags.of(app).add('Environment', preview ? 'preview' : 'production');
Tags.of(app).add('Project', 'marketinghub');
Tags.of(app).add('Owner', 'jbutts@nsightcare.com');
Tags.of(app).add('ManagedBy', 'cdk');
Tags.of(app).add('DataClassification', 'phi');

new AppStack(app, 'MarketingHubApp', { env });

app.synth();
