#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { EdgeStack } from '../lib/edge-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

// Tear-downable "preview" profile. Default (absent/false) = production compliance stack,
// UNCHANGED. When previewMode=true: a lightweight, fully deletable Supabase (no
// irreversible locks, no public Studio/Edge, no observability) reached in-VPC via Kong.
const previewCtx = app.node.tryGetContext('previewMode');
const preview = previewCtx === true || previewCtx === 'true';

// Stack-level tags (propagate to every taggable resource). These mirror the
// tags applied to the deployed Supabase* CloudFormation stacks out-of-band on
// 2026-07-14 so the next `cdk deploy` preserves rather than strips them.
// NOTE: a CloudFormation update of SupabaseCompute replaces the EC2 host
// (AMI resolved via SSM latest) — do not deploy for tags alone.
Tags.of(app).add('Environment', preview ? 'preview' : 'production');
Tags.of(app).add('Project', 'marketinghub');
Tags.of(app).add('Owner', 'jbutts@nsightcare.com');
Tags.of(app).add('ManagedBy', 'cdk');
Tags.of(app).add('DataClassification', 'phi');

const foundation = new FoundationStack(app, 'SupabaseFoundation', { env, preview });
const network = new NetworkStack(app, 'SupabaseNetwork', { env, preview, logsKey: foundation.logsKey });
const data = new DataStack(app, 'SupabaseData', {
  env,
  preview,
  dataKey: foundation.dataKey,
  backupKey: foundation.backupKey,
  secretsKey: foundation.secretsKey,
});

const compute = new ComputeStack(app, 'SupabaseCompute', {
  env,
  preview,
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

// Preview intentionally omits EdgeStack (public Studio/WAF/ALBs) and ObservabilityStack
// (alarms/CloudTrail/log archive/AWS Backup event wiring). The app reaches Supabase via
// Kong in-VPC over HTTP using the ComputeStack host-IP output.
if (!preview) {
  new EdgeStack(app, 'SupabaseEdge', {
    env,
    vpc: network.vpc,
    albSg: network.albSg,
    internalClientSg: network.internalClientSg,
    instance: compute.instance,
  });

  new ObservabilityStack(app, 'SupabaseObservability', {
    env,
    instance: compute.instance,
    backupVault: data.backupVault,
    logsKey: foundation.logsKey,
    vpc: network.vpc,
    internalClientSg: network.internalClientSg,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
  });
}

app.synth();
