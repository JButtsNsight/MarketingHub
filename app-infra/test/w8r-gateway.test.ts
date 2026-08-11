import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

// ---------------------------------------------------------------------------
// Wave-8R: the context-flagged headless-claude gateway wiring for intel
// agentic search (/intel/search FTS candidates → gateway rerank + synthesis).
//
//   headlessClaudeUrl (OPTIONAL)             — plain env HEADLESS_CLAUDE_URL
//     on the APP container only (smsLinkBaseUrl precedent: the URL is not
//     secret material; omitted entirely when unset).
//   headlessClaudeApiKeySecretArn (OPTIONAL) — HEADLESS_CLAUDE_API_KEY on the
//     APP container only, as the `api_key` JSON-field valueFrom ref of the
//     marketinghub/headless-claude secret (never plaintext env), with the
//     execution role granted read on the exact ARN. Same CMK as the
//     sms-campaigns secret ⇒ NO new kms:Decrypt statement.
//
// BOTH absent (default) ⇒ the synthesized template is byte-identical to the
// pre-W8R state, and neither name appears anywhere. The WORKER task-def NEVER
// gets either (no search surface; secret-frozen per runbook §9.4). The live
// service's delivery is the staged /tmp/stage-w8-gateway-env.sh; this wiring
// exists so future flag-ON cdk deploys keep the env/secret instead of
// stripping them (the W4/W6 drift lesson).
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

const GATEWAY_URL = 'https://tr9vow8etd.execute-api.us-east-1.amazonaws.com';
const GATEWAY_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/headless-claude-MnOpQr';

function make(context: Record<string, unknown>, id = 'App'): Template {
  const app = new App({ context });
  return Template.fromStack(new AppStack(app, id, { env }));
}

const gatewayContext = {
  ...CONTEXT,
  headlessClaudeUrl: GATEWAY_URL,
  headlessClaudeApiKeySecretArn: GATEWAY_SECRET_ARN,
};

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** The task definition whose ContainerDefinitions include a container named `name`. */
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

/** All env + secret NAMES across every container of every task def. */
function allNames(template: Template): string[] {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  return (Object.values(taskDefs) as any[]).flatMap((td) =>
    (td.Properties.ContainerDefinitions ?? []).flatMap((c: any) => [
      ...(c.Secrets ?? []).map((s: any) => s.Name),
      ...(c.Environment ?? []).map((e: any) => e.Name),
    ]),
  );
}

test('default (both props absent): HEADLESS_CLAUDE_* appears NOWHERE (both modes)', () => {
  for (const template of [
    make({ ...CONTEXT }),
    make({ ...CONTEXT, previewMode: true }, 'AppPreview'),
  ]) {
    expect(allNames(template).filter((n) => n.startsWith('HEADLESS_CLAUDE'))).toHaveLength(0);
    expect(JSON.stringify(template.toJSON())).not.toContain('HEADLESS_CLAUDE');
  }
});

test('url alone: APP container gets HEADLESS_CLAUDE_URL as plaintext env; NO secret, NO worker env', () => {
  const template = make({ ...CONTEXT, headlessClaudeUrl: GATEWAY_URL });
  const app = container(findTaskDef(template, 'app'), 'app');
  expect((app.Environment ?? []).find((e: any) => e.Name === 'HEADLESS_CLAUDE_URL')?.Value).toBe(
    GATEWAY_URL,
  );
  // The URL is env, never a secret — and no key secret without its own context.
  expect(
    allNames(template).filter((n) => n === 'HEADLESS_CLAUDE_API_KEY'),
  ).toHaveLength(0);
  const worker = container(findTaskDef(template, 'worker'), 'worker');
  expect(
    [
      ...(worker.Secrets ?? []).map((s: any) => s.Name),
      ...(worker.Environment ?? []).map((e: any) => e.Name),
    ].filter((n: string) => n.startsWith('HEADLESS_CLAUDE')),
  ).toHaveLength(0);
});

test('secret arn on: APP container gets the key as the api_key JSON-field valueFrom ref, never env', () => {
  const template = make(gatewayContext);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'HEADLESS_CLAUDE_API_KEY',
            ValueFrom: `${GATEWAY_SECRET_ARN}:api_key::`,
          }),
        ]),
      }),
    ]),
  });
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('HEADLESS_CLAUDE_API_KEY');
      }
    }
  }
});

test('secret arn on: the WORKER container NEVER gets the key (secret-frozen, runbook §9.4)', () => {
  const template = make(gatewayContext);
  const worker = container(findTaskDef(template, 'worker'), 'worker');
  // Exactly the three baseline secrets (MONDAY_API_TOKEN is the one
  // documented §9.4 exception, 2026-08-11) — the gateway key never joins.
  expect(((worker.Secrets ?? []) as any[]).map((s) => s.Name).sort()).toEqual([
    'MONDAY_API_TOKEN',
    'SIMPLETEXTING_API_TOKEN',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
  expect((worker.Environment ?? []).map((e: any) => e.Name)).not.toContain('HEADLESS_CLAUDE_URL');
});

test('secret arn on: the APP execution role reads the EXACT secret ARN (no wildcard) and gains NO new kms:Decrypt', () => {
  const template = make(gatewayContext);
  const appTd = findTaskDef(template, 'app');
  const execRoleId = appTd.Properties.ExecutionRoleArn['Fn::GetAtt'][0];
  const statements = Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === execRoleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);

  const getSecret = statements.filter((s) =>
    asList(s.Action).includes('secretsmanager:GetSecretValue'),
  );
  const grantedArns = getSecret.flatMap((s) => asList(s.Resource));
  expect(grantedArns).toContain(GATEWAY_SECRET_ARN);
  for (const r of grantedArns) {
    expect(typeof r).toBe('string');
    expect(r).not.toContain('*');
    expect(r).not.toContain('??????');
  }

  // Same CMK as the sms-campaigns secret (provision script derives it), so the
  // ONE existing kms:Decrypt statement must remain the only one — flag-ON adds
  // no KMS statement.
  const kms = statements.filter((s) => asList(s.Action).includes('kms:Decrypt'));
  expect(kms).toHaveLength(1);
  expect(asList(kms[0].Resource)).toEqual([CONTEXT.supabaseSecretsKmsKeyArn]);
});

test('the full W8R activation shape (url + key) works in BOTH modes; url env rides the app container only', () => {
  for (const template of [
    make(gatewayContext),
    make({ ...gatewayContext, previewMode: true }, 'AppPreview'),
  ]) {
    const app = container(findTaskDef(template, 'app'), 'app');
    expect(
      (app.Environment ?? []).find((e: any) => e.Name === 'HEADLESS_CLAUDE_URL')?.Value,
    ).toBe(GATEWAY_URL);
    expect(((app.Secrets ?? []) as any[]).map((s) => s.Name)).toContain(
      'HEADLESS_CLAUDE_API_KEY',
    );
    const worker = container(findTaskDef(template, 'worker'), 'worker');
    expect(
      [
        ...(worker.Secrets ?? []).map((s: any) => s.Name),
        ...(worker.Environment ?? []).map((e: any) => e.Name),
      ].filter((n: string) => n.startsWith('HEADLESS_CLAUDE')),
    ).toHaveLength(0);
  }
});
