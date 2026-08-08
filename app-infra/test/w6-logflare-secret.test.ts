import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

// ---------------------------------------------------------------------------
// Wave-6: LOGFLARE_PRIVATE_ACCESS_TOKEN rides the SAME context-flagged
// app-config block Wave 5 added (supabaseAppConfigSecretArn, default OFF):
//   * flag OFF  -> the token appears NOWHERE (default synth unchanged);
//   * flag ON   -> APP container only, as a JSON-field valueFrom ref
//                  (<arn>:LOGFLARE_PRIVATE_ACCESS_TOKEN::), never plaintext
//                  env, and NEVER on the worker (BYPASSRLS dispatcher stays
//                  logs-free too — runbook §9.4 / §11).
// The out-of-band delivery for the live service is /tmp/stage-w6-env.sh;
// this wiring exists so future flag-ON cdk deploys keep the var instead of
// stripping it (the W4 drift lesson).
// ---------------------------------------------------------------------------

const env = { account: '439024109088', region: 'us-east-1' };

// Mirror of realtime-alb.test.ts's CONTEXT literal (test files can't import
// from each other) — keep in sync if the required-context contract changes.
const CONTEXT: Record<string, string> = {
  appHostname: 'marketinghub.nsightcare.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  hostedZoneName: 'nsightcare.com',
  googleSamlMetadataUrl: 'https://accounts.google.com/o/saml2/idp?idpid=C00n27oyt&metadata=true',
  adminGroup: 'marketinghub-admins',
  marketingGroup: 'marketing',
  cognitoDomainPrefix: 'nsight-marketinghub',
  appImageTag: '439024109088.dkr.ecr.us-east-1.amazonaws.com/marketinghub-web:v1',
  supabaseUrl: 'https://supabase.marketinghub.nsightcare.com',
  supabaseServiceRoleSecretArn:
    'arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/supabase-service-role-AbCdEf',
  supabaseSecretsKmsKeyArn:
    'arn:aws:kms:us-east-1:439024109088:key/00000000-1111-2222-3333-444444444444',
  smsSecretsArn:
    'arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/sms-campaigns-GhIjKl',
  supabaseVpcId: 'vpc-0a1b2c3d4e5f60718',
  supabaseVpcAzs: 'us-east-1a,us-east-1b',
  supabasePublicSubnetIds: 'subnet-0aaaa1111bbbb2221,subnet-0aaaa1111bbbb2222',
  supabasePrivateSubnetIds: 'subnet-0cccc3333dddd4441,subnet-0cccc3333dddd4442',
  supabaseInternalClientSgId: 'sg-0123456789abcdef0',
};

const APP_CONFIG_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:439024109088:secret:nsight-supabase/app-config-XyZaBc';
const APP_CONFIG_KMS_KEY_ARN =
  'arn:aws:kms:us-east-1:439024109088:key/55555555-6666-7777-8888-999999999999';

function make(context: Record<string, unknown>, id = 'App'): Template {
  const app = new App({ context });
  return Template.fromStack(new AppStack(app, id, { env }));
}

const appConfigContext = {
  ...CONTEXT,
  supabaseAppConfigSecretArn: APP_CONFIG_SECRET_ARN,
  supabaseAppConfigKmsKeyArn: APP_CONFIG_KMS_KEY_ARN,
};

test('default (flag off): LOGFLARE_PRIVATE_ACCESS_TOKEN appears NOWHERE (both modes)', () => {
  for (const template of [
    make({ ...CONTEXT }),
    make({ ...CONTEXT, previewMode: true }, 'AppPreview'),
  ]) {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const td of Object.values(taskDefs) as any[]) {
      for (const c of td.Properties.ContainerDefinitions ?? []) {
        const names = [
          ...(c.Secrets ?? []).map((s: any) => s.Name),
          ...(c.Environment ?? []).map((e: any) => e.Name),
        ];
        expect(names).not.toContain('LOGFLARE_PRIVATE_ACCESS_TOKEN');
      }
    }
  }
});

test('app-config on: APP container gets the token as a JSON-field valueFrom ref, never env', () => {
  const template = make(appConfigContext);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'LOGFLARE_PRIVATE_ACCESS_TOKEN',
            ValueFrom: `${APP_CONFIG_SECRET_ARN}:LOGFLARE_PRIVATE_ACCESS_TOKEN::`,
          }),
        ]),
      }),
    ]),
  });
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('LOGFLARE_PRIVATE_ACCESS_TOKEN');
      }
    }
  }
});

test('app-config on: the WORKER container NEVER gets the token', () => {
  const template = make(appConfigContext);
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  const workerTd = Object.values(taskDefs).find((td: any) =>
    (td.Properties.ContainerDefinitions ?? []).some((c: any) => c.Name === 'worker'),
  ) as any;
  expect(workerTd).toBeDefined();
  const worker = workerTd.Properties.ContainerDefinitions.find((c: any) => c.Name === 'worker');
  const names = [
    ...(worker.Secrets ?? []).map((s: any) => s.Name),
    ...(worker.Environment ?? []).map((e: any) => e.Name),
  ];
  expect(names).not.toContain('LOGFLARE_PRIVATE_ACCESS_TOKEN');
});
