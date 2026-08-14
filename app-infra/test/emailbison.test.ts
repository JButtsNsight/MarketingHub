import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

// ---------------------------------------------------------------------------
// Email Campaign Center: the context-flagged EmailBison secret wiring.
//
//   emailbisonSecretArn (OPTIONAL) — plaintext env EMAILBISON_SECRET_ARN on
//     the APP container only (an ARN is not secret material), plus TASK-ROLE
//     runtime read+WRITE on exactly that secret (the connect UI persists the
//     pasted API token via PutSecretValue at run time — no deploy needed) and
//     Decrypt+GenerateDataKey on the shared CMK.
//
// Absent (default) ⇒ the synthesized template mentions EMAILBISON nowhere.
// The WORKER task-def NEVER gets any of it.
// ---------------------------------------------------------------------------

const env = { account: '439024109088', region: 'us-east-1' };

// Mirror of app-stack.test.ts's CONTEXT literal (test files can't import from
// each other) — keep in sync if the required-context contract changes.
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

const EB_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/emailbison-StUvWx';

function make(context: Record<string, unknown>, id = 'App'): Template {
  const app = new App({ context });
  return Template.fromStack(new AppStack(app, id, { env }));
}

function findTaskDef(template: Template, name: 'app' | 'worker'): any {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  const td = Object.values(taskDefs).find((t: any) =>
    (t.Properties.ContainerDefinitions ?? []).some((c: any) => c.Name === name),
  );
  expect(td).toBeDefined();
  return td;
}

function container(td: any, name: 'app' | 'worker'): any {
  return td.Properties.ContainerDefinitions.find((c: any) => c.Name === name);
}

test('default (context absent): EMAILBISON appears NOWHERE (both modes)', () => {
  for (const template of [
    make({ ...CONTEXT }),
    make({ ...CONTEXT, previewMode: true }, 'AppPreview'),
  ]) {
    expect(JSON.stringify(template.toJSON())).not.toContain('EMAILBISON');
    expect(JSON.stringify(template.toJSON())).not.toContain('emailbison');
  }
});

test('context set: APP container gets the ARN env; worker gets nothing', () => {
  const template = make({ ...CONTEXT, emailbisonSecretArn: EB_SECRET_ARN });
  const app = container(findTaskDef(template, 'app'), 'app');
  expect(
    (app.Environment ?? []).find((e: any) => e.Name === 'EMAILBISON_SECRET_ARN')
      ?.Value,
  ).toBe(EB_SECRET_ARN);
  // Never a start-time Secret (the app reads/writes it at run time instead).
  expect((app.Secrets ?? []).map((s: any) => s.Name)).not.toContain(
    'EMAILBISON_SECRET_ARN',
  );
  const worker = container(findTaskDef(template, 'worker'), 'worker');
  expect(
    JSON.stringify([worker.Environment ?? [], worker.Secrets ?? []]),
  ).not.toContain('EMAILBISON');
});

test('context set: the APP task role may read AND write exactly that secret', () => {
  const template = make({ ...CONTEXT, emailbisonSecretArn: EB_SECRET_ARN });
  const policies = Object.values(
    template.findResources('AWS::IAM::Policy'),
  ) as any[];
  const statements = policies.flatMap(
    (p) => p.Properties.PolicyDocument?.Statement ?? [],
  );
  const secretStmt = statements.find(
    (s: any) => s.Resource === EB_SECRET_ARN,
  );
  expect(secretStmt).toBeDefined();
  expect(secretStmt.Action).toEqual(
    expect.arrayContaining([
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
      'secretsmanager:DescribeSecret',
    ]),
  );
  // Writing a CMK-encrypted secret needs GenerateDataKey alongside Decrypt.
  const kmsStmt = statements.find(
    (s: any) =>
      s.Resource === CONTEXT.supabaseSecretsKmsKeyArn &&
      JSON.stringify(s.Action).includes('kms:GenerateDataKey'),
  );
  expect(kmsStmt).toBeDefined();
});
