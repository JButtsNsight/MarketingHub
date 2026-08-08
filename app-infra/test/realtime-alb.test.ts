import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

// ---------------------------------------------------------------------------
// Wave-5: the context-flagged browser-Realtime bypass + app-config secrets.
//
//   enableRealtimeAlb           (default OFF) — /realtime/v1/* listener rule
//                               → NEW IP target group → Supabase host Kong :8000
//   supabaseAppConfigSecretArn  (default OFF) — SUPABASE_JWT_SECRET +
//                               SUPABASE_ANON_KEY as ECS valueFrom secrets on
//                               the APP container (folds the W4 drift into cdk)
//
// The DEFAULT state must synthesize a template identical to pre-Wave-5 —
// app-stack.test.ts (untouched by Wave 5) plus the default-state assertions
// here prove it. This file owns every flag-ON assertion.
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

// Flag-on deploys pass the Supabase host by IP (the preview reality) — an IP
// target group cannot register a hostname.
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
const prodRealtime = () =>
  make({ ...CONTEXT, supabaseUrl: REALTIME_SUPABASE_URL, enableRealtimeAlb: 'true' });
const previewRealtime = () =>
  make(
    { ...CONTEXT, previewMode: true, supabaseUrl: REALTIME_SUPABASE_URL, enableRealtimeAlb: 'true' },
    'AppPreview',
  );

/** Every listener rule whose path-pattern includes /realtime/v1/*. */
function realtimeRules(template: Template): any[] {
  const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  return Object.values(rules).filter((r: any) =>
    (r.Properties.Conditions ?? []).some(
      (c: any) =>
        c.Field === 'path-pattern' &&
        (c.PathPatternConfig?.Values ?? c.Values ?? []).includes('/realtime/v1/*'),
    ),
  );
}

// ---------------------------------------------------------------------------
// DEFAULT (flags absent): synth is UNCHANGED from pre-Wave-5.
// ---------------------------------------------------------------------------

test('default (prod): exactly ONE target group and the pre-Wave-5 THREE listener rules', () => {
  const template = prodDefault();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
  expect(realtimeRules(template)).toHaveLength(0);
});

test('default (preview): exactly ONE target group and ZERO listener rules', () => {
  const template = previewDefault();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
});

test('flag absent and enableRealtimeAlb="false" synthesize IDENTICAL templates (both modes)', () => {
  // The flag is a strict === 'true'/true check: any other value (including the
  // explicit 'false' a rollback deploy would pass) is byte-identical to absent.
  expect(make({ ...CONTEXT, enableRealtimeAlb: 'false' }).toJSON()).toEqual(
    prodDefault().toJSON(),
  );
  expect(
    make({ ...CONTEXT, previewMode: true, enableRealtimeAlb: 'false' }, 'AppPreview').toJSON(),
  ).toEqual(previewDefault().toJSON());
});

test('default: NO container anywhere carries SUPABASE_JWT_SECRET or SUPABASE_ANON_KEY', () => {
  for (const template of [prodDefault(), previewDefault()]) {
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const td of Object.values(taskDefs) as any[]) {
      for (const c of td.Properties.ContainerDefinitions ?? []) {
        const names = [
          ...(c.Secrets ?? []).map((s: any) => s.Name),
          ...(c.Environment ?? []).map((e: any) => e.Name),
        ];
        expect(names).not.toContain('SUPABASE_JWT_SECRET');
        expect(names).not.toContain('SUPABASE_ANON_KEY');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// enableRealtimeAlb=true: TG + rule on BOTH the prod HTTPS and preview HTTP
// listeners.
// ---------------------------------------------------------------------------

const REALTIME_MODES: ReadonlyArray<[string, () => Template, number]> = [
  ['production', prodRealtime, 4], // health(10) + webhook(20) + realtime(25) + /l/*(30)
  ['preview', previewRealtime, 1], // realtime(25) is preview's ONLY rule
];

for (const [mode, makeOn, expectedRuleCount] of REALTIME_MODES) {
  test(`realtime on (${mode}): a SECOND target group — IP target ${'10.60.2.224'}:8000, HTTP1, 404-matcher health check on /`, () => {
    const template = makeOn();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8000,
      Protocol: 'HTTP',
      // WebSocket needs HTTP/1.1 on the target connection.
      ProtocolVersion: 'HTTP1',
      TargetType: 'ip',
      Targets: [{ Id: '10.60.2.224' }],
      // Kong answers 404 at its root — that IS the healthy signal.
      HealthCheckPath: '/',
      Matcher: { HttpCode: '404' },
    });
  });

  test(`realtime on (${mode}): /realtime/v1/* rule — priority 25, plain forward, NO cognito, NO method scoping`, () => {
    const template = makeOn();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', expectedRuleCount);
    const matches = realtimeRules(template);
    expect(matches).toHaveLength(1);
    const rule = matches[0];
    expect(rule.Properties.Priority).toBe(25);
    // Plain forward only — a Cognito redirect would break the WS handshake.
    const ruleActions = rule.Properties.Actions ?? [];
    expect(ruleActions.some((a: any) => a.Type === 'authenticate-cognito')).toBe(false);
    expect(ruleActions.some((a: any) => a.Type === 'forward')).toBe(true);
    // NOT method-scoped: GET (websocket upgrade) AND POST (/realtime/v1/api/
    // broadcast REST fallback) must both pass.
    const conditions = rule.Properties.Conditions ?? [];
    expect(conditions.some((c: any) => c.Field === 'http-request-method')).toBe(false);
    // The forward targets the realtime TG, not the app TG.
    expect(JSON.stringify(ruleActions)).toContain('RealtimeTargetGroup');
  });
}

test('realtime on (production): the pre-existing 10/20/30 exceptions are untouched', () => {
  const template = prodRealtime();
  const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  const priorities = Object.values(rules)
    .map((r: any) => r.Properties.Priority)
    .sort((a: number, b: number) => a - b);
  expect(priorities).toEqual([10, 20, 25, 30]);
});

test('realtime on: a NON-IP supabaseUrl host fails loud at synth (IP target group)', () => {
  // CONTEXT's production supabaseUrl is a hostname — an IP target group can
  // never register it; the stack must refuse rather than deploy a dead TG.
  const app = new App({ context: { ...CONTEXT, enableRealtimeAlb: 'true' } });
  expect(() => Template.fromStack(new AppStack(app, 'App', { env }))).toThrow(/IPv4/);
});

// ---------------------------------------------------------------------------
// supabaseAppConfigSecretArn: SUPABASE_JWT_SECRET + SUPABASE_ANON_KEY on the
// APP container only (never the worker), with exact-ARN IAM/KMS grants.
// Independent of enableRealtimeAlb.
// ---------------------------------------------------------------------------

const appConfigContext = {
  ...CONTEXT,
  supabaseAppConfigSecretArn: APP_CONFIG_SECRET_ARN,
  supabaseAppConfigKmsKeyArn: APP_CONFIG_KMS_KEY_ARN,
};

test('app-config on: the APP container gets both secrets as JSON-field valueFrom refs', () => {
  const template = make(appConfigContext);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'SUPABASE_JWT_SECRET',
            ValueFrom: `${APP_CONFIG_SECRET_ARN}:JWT_SECRET::`,
          }),
          Match.objectLike({
            Name: 'SUPABASE_ANON_KEY',
            ValueFrom: `${APP_CONFIG_SECRET_ARN}:ANON_KEY::`,
          }),
        ]),
      }),
    ]),
  });
  // Never as plaintext env.
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('SUPABASE_JWT_SECRET');
        expect(e.Name).not.toBe('SUPABASE_ANON_KEY');
      }
    }
  }
});

test('app-config on: the WORKER container gets NEITHER secret (BYPASSRLS dispatcher, runbook §9.4)', () => {
  const template = make(appConfigContext);
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  const workerTd = Object.values(taskDefs).find((td: any) =>
    (td.Properties.ContainerDefinitions ?? []).some((c: any) => c.Name === 'worker'),
  ) as any;
  expect(workerTd).toBeDefined();
  const worker = workerTd.Properties.ContainerDefinitions.find((c: any) => c.Name === 'worker');
  const secretNames = (worker.Secrets ?? []).map((s: any) => s.Name);
  expect(secretNames).not.toContain('SUPABASE_JWT_SECRET');
  expect(secretNames).not.toContain('SUPABASE_ANON_KEY');
});

test('app-config on: exec-role grants — GetSecretValue on the exact secret ARN + kms:Decrypt on its CMK', () => {
  const template = make(appConfigContext);
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement as any[],
  );
  const asList = (v: unknown) => (Array.isArray(v) ? v : [v]);
  expect(
    statements.some(
      (s) =>
        asList(s.Action).includes('secretsmanager:GetSecretValue') &&
        asList(s.Resource).includes(APP_CONFIG_SECRET_ARN),
    ),
  ).toBe(true);
  expect(
    statements.some(
      (s) =>
        asList(s.Action).includes('kms:Decrypt') &&
        asList(s.Resource).includes(APP_CONFIG_KMS_KEY_ARN),
    ),
  ).toBe(true);
});

test('app-config on WITHOUT its CMK ARN fails loud (task would die at start otherwise)', () => {
  const app = new App({
    context: { ...CONTEXT, supabaseAppConfigSecretArn: APP_CONFIG_SECRET_ARN },
  });
  expect(() => Template.fromStack(new AppStack(app, 'App', { env }))).toThrow(
    /supabaseAppConfigKmsKeyArn/,
  );
});

test('app-config on alone adds NO target group / listener rule (flags are independent)', () => {
  const template = make(appConfigContext);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 3);
});

// ---------------------------------------------------------------------------
// workerImageTag: pins the WORKER (SMS dispatcher) image independently of the
// app. The live app/worker task-defs have drifted apart out-of-band — a deploy
// deriving only appImageTag would silently roll the dispatcher onto the app's
// image (no circuit breaker on the WorkerService to catch a bad boot).
// Absent ⇒ worker follows appImageTag (pre-Wave-5 behavior, default synth
// unchanged — the flag-absent identity tests above already prove it).
// ---------------------------------------------------------------------------

const WORKER_IMAGE_TAG =
  '439024109088.dkr.ecr.us-east-1.amazonaws.com/marketinghub-app:main-201c8f3';

function containerImage(template: Template, name: string): unknown {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      if (c.Name === name) return c.Image;
    }
  }
  return undefined;
}

test('workerImageTag absent: the worker runs the app image (pre-W5 behavior)', () => {
  const template = prodDefault();
  expect(containerImage(template, 'worker')).toBe(CONTEXT.appImageTag);
  expect(containerImage(template, 'app')).toBe(CONTEXT.appImageTag);
});

test('workerImageTag set: the worker is pinned to it while the app keeps appImageTag (both modes)', () => {
  for (const extra of [{}, { previewMode: true }]) {
    const template = make(
      { ...CONTEXT, ...extra, workerImageTag: WORKER_IMAGE_TAG },
      'previewMode' in extra ? 'AppPreview' : 'App',
    );
    expect(containerImage(template, 'worker')).toBe(WORKER_IMAGE_TAG);
    expect(containerImage(template, 'app')).toBe(CONTEXT.appImageTag);
  }
});

test('the full W5 preview deploy shape (both flags on) synthesizes rule + TG + secrets together', () => {
  // Exactly what /tmp/deploy-w5-infra.sh passes.
  const template = make(
    {
      ...CONTEXT,
      previewMode: true,
      supabaseUrl: REALTIME_SUPABASE_URL,
      enableRealtimeAlb: 'true',
      supabaseAppConfigSecretArn: APP_CONFIG_SECRET_ARN,
      supabaseAppConfigKmsKeyArn: APP_CONFIG_KMS_KEY_ARN,
    },
    'AppPreview',
  );
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 2);
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 1);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'app',
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: 'SUPABASE_JWT_SECRET' }),
          Match.objectLike({ Name: 'SUPABASE_ANON_KEY' }),
        ]),
      }),
    ]),
  });
});
