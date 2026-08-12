import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

// ---------------------------------------------------------------------------
// Wave-8: the context-flagged Bedrock Titan embeddings activation.
//
//   enableBedrockEmbeddings (default OFF) — flips the competitor-intel
//   embedding provider from the deterministic stub to real Bedrock calls:
//     * env  CI_EMBED_PROVIDER=bedrock + CI_EMBED_MODEL_ID on the APP container
//       (query embedding, /intel/search) AND the WORKER container (the
//       ci_embed queue consumer) — plaintext env, neither value is a secret;
//     * IAM  bedrock:InvokeModel on EXACTLY the pinned Titan V2 foundation-model
//       ARN, on BOTH TASK roles — never the execution roles. (Since Wave-D the
//       APP task role also carries an always-on cognito-idp statement whenever
//       the user pool exists; the WORKER task role stays bare by default.)
//     * NO new secret anywhere, and the WORKER task-def stays secret-frozen
//       (runbook §9.4 — the w6 test guards JWT/anon/logflare; this one guards
//       the whole worker Secrets list under the W8 flag). The frozen baseline
//       is THREE secrets since 2026-08-11: MONDAY_API_TOKEN joined as the one
//       documented §9.4 exception (Monday write-back consumer).
//
// The DEFAULT state must synthesize a template byte-identical to Wave 7 —
// asserted below via flag-absent === flag-'false' === flag-false identity plus
// the untouched app-stack.test.ts. This file owns every flag-ON assertion.
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

/** The ONLY model the flag may authorize — Titan Text Embeddings V2, 1024-dim.
 *  Account field EMPTY by design: foundation models are AWS-owned resources. */
const MODEL_ID = 'amazon.titan-embed-text-v2:0';
const MODEL_ARN = `arn:aws:bedrock:us-east-1::foundation-model/${MODEL_ID}`;

// The W5 flag-ON posture the live preview stack runs with — the staged
// /tmp/stage-w8-bedrock.sh preserves it on the same deploy (values mirror
// realtime-alb.test.ts).
const REALTIME_SUPABASE_URL = 'http://10.60.2.224:8000';
const APP_CONFIG_SECRET_ARN =
  'arn:aws:secretsmanager:us-east-1:439024109088:secret:nsight-supabase/app-config-XyZaBc';
const APP_CONFIG_KMS_KEY_ARN =
  'arn:aws:kms:us-east-1:439024109088:key/55555555-6666-7777-8888-999999999999';

function make(context: Record<string, unknown>, id = 'App'): Template {
  const app = new App({ context });
  return Template.fromStack(new AppStack(app, id, { env }));
}

const prodDefault = () => make({ ...CONTEXT });
const previewDefault = () => make({ ...CONTEXT, previewMode: true }, 'AppPreview');
const prodOn = () => make({ ...CONTEXT, enableBedrockEmbeddings: 'true' });
const previewOn = () =>
  make({ ...CONTEXT, previewMode: true, enableBedrockEmbeddings: 'true' }, 'AppPreview');

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

/** Logical id of a task def's task/execution role (always a same-stack GetAtt). */
function roleLogicalId(td: any, key: 'TaskRoleArn' | 'ExecutionRoleArn'): string {
  return td.Properties[key]['Fn::GetAtt'][0];
}

/** Every statement of every AWS::IAM::Policy attached to the given role. */
function statementsForRole(template: Template, roleId: string): any[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);
}

function bedrockStatements(statements: any[]): any[] {
  return statements.filter((s) => asList(s.Action).includes('bedrock:InvokeModel'));
}

function envValue(c: any, name: string): unknown {
  return (c.Environment ?? []).find((e: any) => e.Name === name)?.Value;
}

// ---------------------------------------------------------------------------
// DEFAULT (flag absent): synth is byte-identical to Wave 7.
// ---------------------------------------------------------------------------

test('flag absent, "false" and false all synthesize IDENTICAL templates (both modes)', () => {
  // Strict === 'true'/true check: the explicit 'false' a rollback deploy would
  // pass — and a real boolean false — are byte-identical to absent.
  expect(make({ ...CONTEXT, enableBedrockEmbeddings: 'false' }).toJSON()).toEqual(
    prodDefault().toJSON(),
  );
  expect(make({ ...CONTEXT, enableBedrockEmbeddings: false }).toJSON()).toEqual(
    prodDefault().toJSON(),
  );
  expect(
    make(
      { ...CONTEXT, previewMode: true, enableBedrockEmbeddings: 'false' },
      'AppPreview',
    ).toJSON(),
  ).toEqual(previewDefault().toJSON());
});

test('default: NO IAM statement anywhere mentions bedrock (both modes)', () => {
  for (const template of [prodDefault(), previewDefault()]) {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement as any[],
    );
    expect(bedrockStatements(statements)).toHaveLength(0);
    expect(JSON.stringify(template.toJSON())).not.toContain('bedrock');
  }
});

test('default: NO container anywhere carries CI_EMBED_* env or secrets (both modes)', () => {
  for (const template of [prodDefault(), previewDefault()]) {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const td of Object.values(taskDefs) as any[]) {
      for (const c of td.Properties.ContainerDefinitions ?? []) {
        const names = [
          ...(c.Secrets ?? []).map((s: any) => s.Name),
          ...(c.Environment ?? []).map((e: any) => e.Name),
        ];
        expect(names.filter((n: string) => n.startsWith('CI_EMBED_'))).toHaveLength(0);
      }
    }
  }
});

test('default: worker task role has ZERO policies; app task role carries ONLY the Wave-D cognito-idp statement', () => {
  // CONTEXT carries SAML metadata, so the pool (and with it the Wave-D
  // cognito-idp grant on the APP task role) exists in both modes. The flag
  // being off must add nothing beyond that — and never touch the worker.
  for (const template of [prodDefault(), previewDefault()]) {
    const workerTd = findTaskDef(template, 'worker');
    expect(statementsForRole(template, roleLogicalId(workerTd, 'TaskRoleArn'))).toHaveLength(0);
    const appStmts = statementsForRole(
      template,
      roleLogicalId(findTaskDef(template, 'app'), 'TaskRoleArn'),
    );
    expect(appStmts).toHaveLength(1);
    expect(
      asList(appStmts[0].Action).every((a) => String(a).startsWith('cognito-idp:')),
    ).toBe(true);
    expect(bedrockStatements(appStmts)).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// enableBedrockEmbeddings=true: env + task-role IAM on BOTH services.
// ---------------------------------------------------------------------------

const ON_MODES: ReadonlyArray<[string, () => Template]> = [
  ['production', prodOn],
  ['preview', previewOn],
];

for (const [mode, makeOn] of ON_MODES) {
  test(`flag on (${mode}): app AND worker containers get CI_EMBED_PROVIDER=bedrock + the pinned model id as plaintext env`, () => {
    const template = makeOn();
    for (const name of ['app', 'worker'] as const) {
      const c = container(findTaskDef(template, name), name);
      expect(envValue(c, 'CI_EMBED_PROVIDER')).toBe('bedrock');
      expect(envValue(c, 'CI_EMBED_MODEL_ID')).toBe(MODEL_ID);
      // Env, never Secrets — the provider/model id are not secret material.
      const secretNames = (c.Secrets ?? []).map((s: any) => s.Name);
      expect(secretNames.filter((n: string) => n.startsWith('CI_EMBED_'))).toHaveLength(0);
    }
  });

  test(`flag on (${mode}): BOTH task roles gain bedrock:InvokeModel scoped to EXACTLY the Titan V2 model ARN`, () => {
    const template = makeOn();
    for (const name of ['app', 'worker'] as const) {
      const td = findTaskDef(template, name);
      const stmts = bedrockStatements(
        statementsForRole(template, roleLogicalId(td, 'TaskRoleArn')),
      );
      expect(stmts).toHaveLength(1);
      // Model-scoped, no wildcard, single action.
      expect(asList(stmts[0].Action)).toEqual(['bedrock:InvokeModel']);
      expect(asList(stmts[0].Resource)).toEqual([MODEL_ARN]);
      expect(stmts[0].Effect).toBe('Allow');
    }
  });

  test(`flag on (${mode}): the EXECUTION roles gain NO bedrock statement (SigV4 rides the task role)`, () => {
    const template = makeOn();
    for (const name of ['app', 'worker'] as const) {
      const td = findTaskDef(template, name);
      const stmts = statementsForRole(template, roleLogicalId(td, 'ExecutionRoleArn'));
      expect(bedrockStatements(stmts)).toHaveLength(0);
    }
  });

  test(`flag on (${mode}): exactly ONE new IAM policy vs default (the worker task role's), nothing else`, () => {
    // The APP task role's DefaultPolicy already exists by default (the Wave-D
    // cognito-idp grant) — the flag adds a statement there, not a policy; the
    // only NEW policy resource is the worker task role's.
    const defaults = mode === 'production' ? prodDefault() : previewDefault();
    const defaultCount = Object.keys(defaults.findResources('AWS::IAM::Policy')).length;
    const onCount = Object.keys(makeOn().findResources('AWS::IAM::Policy')).length;
    expect(onCount).toBe(defaultCount + 1);
  });

  test(`flag on (${mode}): the WORKER task-def stays secret-frozen — EXACTLY the three baseline secrets, none added by the flag`, () => {
    const template = makeOn();
    const worker = container(findTaskDef(template, 'worker'), 'worker');
    expect(((worker.Secrets ?? []) as any[]).map((s) => s.Name).sort()).toEqual([
      'MONDAY_API_TOKEN',
      'SIMPLETEXTING_API_TOKEN',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });
}

test('flag on accepts a real boolean true as well as the CLI string', () => {
  const template = make({ ...CONTEXT, enableBedrockEmbeddings: true });
  const worker = container(findTaskDef(template, 'worker'), 'worker');
  expect(envValue(worker, 'CI_EMBED_PROVIDER')).toBe('bedrock');
});

test('flag on alone adds NO target group / listener rule / app-config secret (flags are independent)', () => {
  const template = prodOn();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
  const app = container(findTaskDef(template, 'app'), 'app');
  const secretNames = ((app.Secrets ?? []) as any[]).map((s) => s.Name);
  expect(secretNames).not.toContain('SUPABASE_JWT_SECRET');
  expect(secretNames).not.toContain('SUPABASE_ANON_KEY');
  expect(secretNames).not.toContain('LOGFLARE_PRIVATE_ACCESS_TOKEN');
});

test('the full W8 preview activation shape (W5 flags + bedrock) synthesizes everything together', () => {
  // Exactly what /tmp/stage-w8-bedrock.sh passes: the live W5 posture is
  // PRESERVED (realtime TG + app-config secrets) while bedrock turns on.
  const template = make(
    {
      ...CONTEXT,
      previewMode: true,
      supabaseUrl: REALTIME_SUPABASE_URL,
      enableRealtimeAlb: 'true',
      supabaseAppConfigSecretArn: APP_CONFIG_SECRET_ARN,
      supabaseAppConfigKmsKeyArn: APP_CONFIG_KMS_KEY_ARN,
      enableBedrockEmbeddings: 'true',
    },
    'AppPreview',
  );
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
  for (const name of ['app', 'worker'] as const) {
    const td = findTaskDef(template, name);
    expect(envValue(container(td, name), 'CI_EMBED_PROVIDER')).toBe('bedrock');
    expect(
      bedrockStatements(statementsForRole(template, roleLogicalId(td, 'TaskRoleArn'))),
    ).toHaveLength(1);
  }
  // The W6 rule still holds under the combined flags: app-config secrets on
  // the APP container only, the worker keeps exactly its three baseline.
  const worker = container(findTaskDef(template, 'worker'), 'worker');
  expect(((worker.Secrets ?? []) as any[]).map((s) => s.Name).sort()).toEqual([
    'MONDAY_API_TOKEN',
    'SIMPLETEXTING_API_TOKEN',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
});
