import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

const env = { account: '439024109088', region: 'us-east-1' };

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
  // The app runs INSIDE the Supabase VPC (created by the Supabase NetworkStack) and
  // joins its `internalClientSg` — the only path to the private data-API ALB + its
  // private DNS. These come from the NetworkStack CfnOutputs; no VPC is created here.
  supabaseVpcId: 'vpc-0a1b2c3d4e5f60718',
  supabaseVpcAzs: 'us-east-1a,us-east-1b',
  supabasePublicSubnetIds: 'subnet-0aaaa1111bbbb2221,subnet-0aaaa1111bbbb2222',
  supabasePrivateSubnetIds: 'subnet-0cccc3333dddd4441,subnet-0cccc3333dddd4442',
  supabaseInternalClientSgId: 'sg-0123456789abcdef0',
};

/** The exact secret ARN the task consumes — IAM must be scoped to THIS, no wildcard. */
const SERVICE_ROLE_SECRET_ARN = CONTEXT.supabaseServiceRoleSecretArn;

/** The SMS-campaigns JSON secret (Monday + SimpleTexting tokens) app + worker consume. */
const SMS_SECRETS_ARN = CONTEXT.smsSecretsArn;

/** The ONLY exact secret ARNs any GetSecretValue statement may name (no wildcards). */
const ALLOWED_SECRET_ARNS = [SERVICE_ROLE_SECRET_ARN, SMS_SECRETS_ARN];

/** The imported Supabase networking the app must attach to (from NetworkStack outputs). */
const SUPABASE_PRIVATE_SUBNET_IDS = CONTEXT.supabasePrivateSubnetIds.split(',');
const SUPABASE_PUBLIC_SUBNET_IDS = CONTEXT.supabasePublicSubnetIds.split(',');
const SUPABASE_INTERNAL_CLIENT_SG_ID = CONTEXT.supabaseInternalClientSgId;

function makeApp() {
  const app = new App({ context: CONTEXT });
  const stack = new AppStack(app, 'App', { env });
  return { stack, template: Template.fromStack(stack) };
}

/** Context keys ONLY needed by the production Cognito/DNS front door. */
const PRODUCTION_ONLY_CONTEXT_KEYS = [
  'appHostname',
  'hostedZoneId',
  'hostedZoneName',
  'googleSamlMetadataUrl',
  'adminGroup',
  'marketingGroup',
  'cognitoDomainPrefix',
  'supabasePublicSubnetIds',
];

/** Instantiate the stack with the `previewMode` toggle ON. */
function makePreviewApp(context: Record<string, unknown> = { ...CONTEXT, previewMode: true }) {
  const app = new App({ context });
  const stack = new AppStack(app, 'AppPreview', { env });
  return { stack, template: Template.fromStack(stack) };
}

test('missing required context fails loud', () => {
  const app = new App(); // no context
  expect(() => new AppStack(app, 'App', { env })).toThrow(/required context/);
});

test('ACM certificate for the app hostname is DNS-validated', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'marketinghub.nsightcare.com',
    ValidationMethod: 'DNS',
  });
});

test('durable ACM cert is RETAINed on stack delete', () => {
  const { template } = makeApp();
  const certs = template.findResources('AWS::CertificateManager::Certificate');
  expect(Object.keys(certs).length).toBe(1);
  for (const cert of Object.values(certs) as any[]) {
    expect(cert.DeletionPolicy).toBe('Retain');
  }
});

test('Cognito user pool is retained, with a hosted-UI domain', () => {
  const { template } = makeApp();
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  const pools = template.findResources('AWS::Cognito::UserPool');
  for (const p of Object.values(pools) as any[]) {
    expect(p.DeletionPolicy).toBe('Retain');
  }
  template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
    Domain: 'nsight-marketinghub',
  });
});

test('Google SAML IdP wired to the metadata URL from context', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
    ProviderType: 'SAML',
    ProviderName: 'GoogleSAML',
    ProviderDetails: Match.objectLike({
      MetadataURL: 'https://accounts.google.com/o/saml2/idp?idpid=C00n27oyt&metadata=true',
    }),
  });
});

test('both an admin and a marketing Cognito group exist', () => {
  const { template } = makeApp();
  template.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'marketinghub-admins' });
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'marketing' });
});

test('app client uses OAuth code flow with the app idpresponse callback', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: Match.arrayWith(['code']),
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: Match.arrayWith(['https://marketinghub.nsightcare.com/oauth2/idpresponse']),
    LogoutURLs: Match.arrayWith(['https://marketinghub.nsightcare.com/']),
    SupportedIdentityProviders: Match.arrayWith(['GoogleSAML']),
    GenerateSecret: true,
  });
});

test('the task gets a COGNITO_LOGOUT_URL env var for the /logout redirect', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          Match.objectLike({ Name: 'COGNITO_LOGOUT_URL' }),
        ]),
      }),
    ]),
  });
});

test('the task carries SUPABASE_URL (from context) as an env var', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          Match.objectLike({
            Name: 'SUPABASE_URL',
            Value: 'https://supabase.marketinghub.nsightcare.com',
          }),
        ]),
      }),
    ]),
  });
});

// ALB_ARN must reference the front-door ALB (a Ref/GetAtt, not a literal): the
// app's getUser() asserts the x-amzn-oidc-data `signer` equals ALB_ARN, so it
// MUST arrive. AWS_REGION/ALB_REGION drive the ALB public-key endpoint host.
// (`Match.arrayWith` matches an ORDERED subsequence, so assert each env var
// independently rather than relying on their emitted order.)
function hasEnv(
  template: ReturnType<typeof Template.fromStack>,
  name: string,
  value: unknown,
): void {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([Match.objectLike({ Name: name, Value: value })]),
      }),
    ]),
  });
}

test('the task carries an ALB_ARN env referencing the front-door ALB', () => {
  const { template } = makeApp();
  hasEnv(template, 'ALB_ARN', Match.objectLike({ Ref: Match.stringLikeRegexp('PublicAlb') }));
});

test('the task carries AWS_REGION/ALB_REGION = the stack region for the ALB key endpoint', () => {
  const { template } = makeApp();
  hasEnv(template, 'AWS_REGION', 'us-east-1');
  hasEnv(template, 'ALB_REGION', 'us-east-1');
});

test('SUPABASE_SERVICE_ROLE_KEY is injected as a Secrets Manager secret (not a plain env)', () => {
  const { template } = makeApp();
  // It must be a Secret (ValueFrom), never a plaintext Environment value. The
  // secret is JSON, so the ValueFrom carries the `:SERVICE_ROLE_KEY::` field
  // selector (arn:...:secret:name-SUFFIX:FIELD:VERSION-STAGE:VERSION-ID).
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'SUPABASE_SERVICE_ROLE_KEY',
            ValueFrom: `${SERVICE_ROLE_SECRET_ARN}:SERVICE_ROLE_KEY::`,
          }),
        ]),
      }),
    ]),
  });
  // And it must NOT leak into the plaintext Environment block.
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('SUPABASE_SERVICE_ROLE_KEY');
      }
    }
  }
});

test('the app container gets MONDAY_API_TOKEN + SIMPLETEXTING_WEBHOOK_TOKEN from the sms-campaigns secret', () => {
  const { template } = makeApp();
  for (const field of ['MONDAY_API_TOKEN', 'SIMPLETEXTING_WEBHOOK_TOKEN']) {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          Secrets: Match.arrayWith([
            // JSON-field extraction: ValueFrom = <arn>:FIELD::, never plaintext env.
            Match.objectLike({ Name: field, ValueFrom: `${SMS_SECRETS_ARN}:${field}::` }),
          ]),
        }),
      ]),
    });
  }
});

test('execution roles may read ONLY the exact allowlisted secret ARNs (no wildcard)', () => {
  const { template } = makeApp();
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap((p: any) =>
    p.Properties.PolicyDocument.Statement as any[],
  );
  const getSecret = statements.filter((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.includes('secretsmanager:GetSecretValue');
  });
  expect(getSecret.length).toBeGreaterThanOrEqual(1);
  for (const s of getSecret) {
    const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
    for (const r of resources) {
      // Exact ARN strings from the allowlist (service-role + sms-campaigns
      // secrets) — never a "*" and never the "-??????" partial-ARN glob.
      expect(typeof r).toBe('string');
      expect(ALLOWED_SECRET_ARNS).toContain(r);
      expect(r).not.toContain('*');
      expect(r).not.toContain('??????');
    }
  }
});

test('public ALB is internet-facing', () => {
  const { template } = makeApp();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
    Type: 'application',
  });
});

test('the ALB enables S3 access logging to a retained SSE bucket', () => {
  const { template } = makeApp();
  const buckets = template.findResources('AWS::S3::Bucket');
  expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
  // The log bucket is retained and SSE-encrypted with public access blocked.
  const logBucket = Object.values(buckets).find((b: any) =>
    b.DeletionPolicy === 'Retain' && b.Properties?.BucketEncryption,
  ) as any;
  expect(logBucket).toBeDefined();
  expect(logBucket.Properties.PublicAccessBlockConfiguration).toBeDefined();
  const albs = template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer');
  for (const alb of Object.values(albs) as any[]) {
    const attrs = alb.Properties.LoadBalancerAttributes ?? [];
    expect(attrs.some((a: any) => a.Key === 'access_logs.s3.enabled' && a.Value === 'true')).toBe(true);
  }
});

test('the 443 listener DEFAULT action authenticates via Cognito then forwards (whole app authed)', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 443,
    Protocol: 'HTTPS',
    SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', // RECOMMENDED_TLS
    DefaultActions: Match.arrayWith([
      Match.objectLike({ Type: 'authenticate-cognito', Order: 1 }),
      Match.objectLike({ Type: 'forward', Order: 2 }),
    ]),
  });
});

test('the Cognito default action sets an explicit SessionTimeout (not the 7-day default)', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    DefaultActions: Match.arrayWith([
      Match.objectLike({
        Type: 'authenticate-cognito',
        AuthenticateCognitoConfig: Match.objectLike({ SessionTimeout: '43200' }),
      }),
    ]),
  });
});

test('an UNAUTHENTICATED /api/health listener rule forwards without Cognito', () => {
  const { template } = makeApp();
  const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  const healthRule = Object.values(rules).find((r: any) =>
    (r.Properties.Conditions ?? []).some((c: any) =>
      c.Field === 'path-pattern' &&
      (c.PathPatternConfig?.Values ?? c.Values ?? []).includes('/api/health'),
    ),
  ) as any;
  expect(healthRule).toBeDefined();
  const actions = healthRule.Properties.Actions ?? [];
  expect(actions.some((a: any) => a.Type === 'authenticate-cognito')).toBe(false);
  expect(actions.some((a: any) => a.Type === 'forward')).toBe(true);
});

test('an UNAUTHENTICATED POST /api/webhooks/simpletexting listener rule forwards without Cognito', () => {
  const { template } = makeApp();
  const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
  const webhookRule = Object.values(rules).find((r: any) =>
    (r.Properties.Conditions ?? []).some((c: any) =>
      c.Field === 'path-pattern' &&
      (c.PathPatternConfig?.Values ?? c.Values ?? []).includes('/api/webhooks/simpletexting'),
    ),
  ) as any;
  expect(webhookRule).toBeDefined();
  expect(webhookRule.Properties.Priority).toBe(20);
  // Method-scoped: SimpleTexting only ever POSTs; a browser GET on the path
  // still falls through to the Cognito default action.
  const conditions = webhookRule.Properties.Conditions ?? [];
  expect(
    conditions.some(
      (c: any) =>
        c.Field === 'http-request-method' &&
        (c.HttpRequestMethodConfig?.Values ?? []).includes('POST'),
    ),
  ).toBe(true);
  const actions = webhookRule.Properties.Actions ?? [];
  expect(actions.some((a: any) => a.Type === 'authenticate-cognito')).toBe(false);
  expect(actions.some((a: any) => a.Type === 'forward')).toBe(true);
});

test('preview: NO listener rules at all (health + webhook exceptions are production-only)', () => {
  const { template } = makePreviewApp();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::ListenerRule', 0);
});

test('a Fargate service runs desiredCount 2 with public IPs disabled (private subnets)', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ECS::Service', {
    LaunchType: 'FARGATE',
    DesiredCount: 2,
    NetworkConfiguration: Match.objectLike({
      AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
    }),
  });
});

test('the AppStack creates NO VPC and NO NAT gateway — it runs inside the imported Supabase VPC', () => {
  const { template } = makeApp();
  template.resourceCountIs('AWS::EC2::VPC', 0);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('the Fargate service is placed in the imported Supabase PRIVATE subnets', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ECS::Service', {
    NetworkConfiguration: Match.objectLike({
      AwsvpcConfiguration: Match.objectLike({
        // Imported subnet ids appear as literal strings (not a Ref to a local subnet).
        Subnets: Match.arrayWith(SUPABASE_PRIVATE_SUBNET_IDS),
      }),
    }),
  });
});

test('the Fargate service joins the imported Supabase internalClientSg (data-API reachability)', () => {
  const { template } = makeApp();
  // The imported SG id is a literal string in the awsvpc SecurityGroups list — that
  // membership is what lets the tasks reach the Supabase internal data-API ALB.
  template.hasResourceProperties('AWS::ECS::Service', {
    NetworkConfiguration: Match.objectLike({
      AwsvpcConfiguration: Match.objectLike({
        SecurityGroups: Match.arrayWith([SUPABASE_INTERNAL_CLIENT_SG_ID]),
      }),
    }),
  });
});

test('the public ALB is placed in the imported Supabase PUBLIC subnets', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
    Subnets: Match.arrayWith(SUPABASE_PUBLIC_SUBNET_IDS),
  });
});

test('the task image comes from the appImageTag context', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Image: '439024109088.dkr.ecr.us-east-1.amazonaws.com/marketinghub-web:v1',
      }),
    ]),
  });
});

test('the service SG only accepts the container port FROM the ALB SG', () => {
  const { template } = makeApp();
  // The ingress on the service SG must be sourced from the ALB SG (no CIDR).
  const ingresses = template.findResources('AWS::EC2::SecurityGroupIngress');
  const inline = template.findResources('AWS::EC2::SecurityGroup');
  const fromAlb =
    Object.values(ingresses).some((r: any) =>
      r.Properties.SourceSecurityGroupId && r.Properties.FromPort === 3000,
    ) ||
    Object.values(inline).some((sg: any) =>
      (sg.Properties.SecurityGroupIngress ?? []).some(
        (r: any) => r.SourceSecurityGroupId && r.FromPort === 3000,
      ),
    );
  expect(fromAlb).toBe(true);
});

test('a REGIONAL WebACL with managed + rate-based rules is associated to the ALB', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: Match.arrayWith([
      Match.objectLike({
        Statement: Match.objectLike({
          ManagedRuleGroupStatement: Match.objectLike({
            VendorName: 'AWS',
            Name: 'AWSManagedRulesCommonRuleSet',
          }),
        }),
      }),
      Match.objectLike({
        Statement: Match.objectLike({
          ManagedRuleGroupStatement: Match.objectLike({
            Name: 'AWSManagedRulesKnownBadInputsRuleSet',
          }),
        }),
      }),
      Match.objectLike({
        Statement: Match.objectLike({
          RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }),
        }),
      }),
    ]),
  });
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
});

test('CommonRuleSet overrides the body-size/XSS body rules to Count so large HTML email templates upload', () => {
  // POST /api/templates carries the ENTIRE template HTML inline in the JSON
  // body; realistic marketing email HTML routinely exceeds 8 KB and contains
  // markup that trips CrossSiteScripting_BODY. Left at their default Block
  // action, CommonRuleSet's SizeRestrictions_BODY / CrossSiteScripting_BODY
  // would 403 the app's core upload at the WAF edge. Override BOTH to Count.
  const { template } = makeApp();
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Rules: Match.arrayWith([
      Match.objectLike({
        Statement: Match.objectLike({
          ManagedRuleGroupStatement: Match.objectLike({
            Name: 'AWSManagedRulesCommonRuleSet',
            RuleActionOverrides: Match.arrayWith([
              Match.objectLike({ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }),
              Match.objectLike({ Name: 'CrossSiteScripting_BODY', ActionToUse: { Count: {} } }),
            ]),
          }),
        }),
      }),
    ]),
  });
});

test('a Route53 A/ALIAS record points the app hostname at the ALB', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'marketinghub.nsightcare.com.',
    Type: 'A',
  });
});

test('non-preview (default): the task does NOT carry a PREVIEW_AUTH env var', () => {
  const { template } = makeApp();
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('PREVIEW_AUTH');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// previewMode === true: private/internal deployment with NO Cognito/SAML/DNS.
// Selectable via the `previewMode` context toggle; the production front door
// (all assertions above) is unchanged when the toggle is off/absent.
// ---------------------------------------------------------------------------

test('preview: the ALB is INTERNAL (not internet-facing)', () => {
  const { template } = makePreviewApp();
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
    Type: 'application',
  });
});

test('preview: a string "true" also enables preview mode', () => {
  const { template } = makePreviewApp({ ...CONTEXT, previewMode: 'true' });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
  });
});

test('preview: the listener is plain HTTP:80 forwarding to the target group (no auth, no HTTPS)', () => {
  const { template } = makePreviewApp();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: 'HTTP',
    DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'forward' })]),
  });
  // No listener anywhere may authenticate via Cognito in preview mode.
  const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
  for (const l of Object.values(listeners) as any[]) {
    for (const a of l.Properties.DefaultActions ?? []) {
      expect(a.Type).not.toBe('authenticate-cognito');
    }
  }
});

test('preview: ZERO Cognito user pool / SAML IdP / app client / groups', () => {
  const { template } = makePreviewApp();
  template.resourceCountIs('AWS::Cognito::UserPool', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
  template.resourceCountIs('AWS::Cognito::UserPoolGroup', 0);
});

test('preview: ZERO WAFv2 WebACL and ZERO ACM certificate', () => {
  const { template } = makePreviewApp();
  template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
  template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
});

test('preview: ZERO Route53 record', () => {
  const { template } = makePreviewApp();
  template.resourceCountIs('AWS::Route53::RecordSet', 0);
});

test('preview: the task carries PREVIEW_AUTH=marketing and NO ALB_ARN', () => {
  const { template } = makePreviewApp();
  hasEnv(template, 'PREVIEW_AUTH', 'marketing');
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        // preview auth needs no token, so no expected-signer ALB_ARN is set.
        expect(e.Name).not.toBe('ALB_ARN');
      }
    }
  }
});

test('preview: SUPABASE_URL + region envs and the service-role SECRET are still present', () => {
  const { template } = makePreviewApp();
  hasEnv(template, 'SUPABASE_URL', 'https://supabase.marketinghub.nsightcare.com');
  hasEnv(template, 'AWS_REGION', 'us-east-1');
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'SUPABASE_SERVICE_ROLE_KEY',
            ValueFrom: `${SERVICE_ROLE_SECRET_ARN}:SERVICE_ROLE_KEY::`,
          }),
        ]),
      }),
    ]),
  });
});

test('preview: the app container still gets the sms-campaigns secrets', () => {
  const { template } = makePreviewApp();
  for (const field of ['MONDAY_API_TOKEN', 'SIMPLETEXTING_WEBHOOK_TOKEN']) {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'app',
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: field, ValueFrom: `${SMS_SECRETS_ARN}:${field}::` }),
          ]),
        }),
      ]),
    });
  }
});

test('preview: the Fargate service stays in the PRIVATE subnets with public IP disabled and the internalClientSg', () => {
  const { template } = makePreviewApp();
  template.hasResourceProperties('AWS::ECS::Service', {
    LaunchType: 'FARGATE',
    DesiredCount: 2,
    NetworkConfiguration: Match.objectLike({
      AwsvpcConfiguration: Match.objectLike({
        AssignPublicIp: 'DISABLED',
        Subnets: Match.arrayWith(SUPABASE_PRIVATE_SUBNET_IDS),
        SecurityGroups: Match.arrayWith([SUPABASE_INTERNAL_CLIENT_SG_ID]),
      }),
    }),
  });
});

test('preview: the internal ALB is placed in the imported Supabase PRIVATE subnets', () => {
  const { template } = makePreviewApp();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
    Subnets: Match.arrayWith(SUPABASE_PRIVATE_SUBNET_IDS),
  });
});

test('preview: the service SG still only accepts :3000 FROM the ALB SG', () => {
  const { template } = makePreviewApp();
  const ingresses = template.findResources('AWS::EC2::SecurityGroupIngress');
  const inline = template.findResources('AWS::EC2::SecurityGroup');
  const fromAlb =
    Object.values(ingresses).some((r: any) =>
      r.Properties.SourceSecurityGroupId && r.Properties.FromPort === 3000,
    ) ||
    Object.values(inline).some((sg: any) =>
      (sg.Properties.SecurityGroupIngress ?? []).some(
        (r: any) => r.SourceSecurityGroupId && r.FromPort === 3000,
      ),
    );
  expect(fromAlb).toBe(true);
});

test('preview: synthesizes with NO Google-SAML/Cognito/DNS context supplied', () => {
  const minimal: Record<string, unknown> = { ...CONTEXT, previewMode: true };
  for (const k of PRODUCTION_ONLY_CONTEXT_KEYS) delete minimal[k];
  const app = new App({ context: minimal });
  expect(() =>
    Template.fromStack(new AppStack(app, 'AppPreviewMinimal', { env })),
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// SMS dispatcher worker: a SECOND, ALB-less Fargate service (BOTH modes) that
// runs the same image with the worker.cjs entrypoint, polling the outbox. One
// task, min 0 / max 100 so a deploy never runs two dispatchers at once.
// ---------------------------------------------------------------------------

/** The worker task definition — the one whose (only) container is named 'worker'. */
function findWorkerTaskDef(template: ReturnType<typeof Template.fromStack>) {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  return Object.values(taskDefs).find((td: any) =>
    (td.Properties.ContainerDefinitions ?? []).some((c: any) => c.Name === 'worker'),
  ) as any;
}

/** The worker Fargate service — the only service with DesiredCount 1. */
function findWorkerService(template: ReturnType<typeof Template.fromStack>) {
  const services = template.findResources('AWS::ECS::Service');
  return Object.values(services).find((s: any) => s.Properties.DesiredCount === 1) as any;
}

const MODES: ReadonlyArray<[string, () => { template: ReturnType<typeof Template.fromStack> }]> =
  [
    ['production', makeApp],
    ['preview', () => makePreviewApp()],
  ];

for (const [mode, make] of MODES) {
  test(`worker (${mode}): small taskdef runs the SAME image with Command ['worker.cjs'] and NO ports`, () => {
    const { template } = make();
    const td = findWorkerTaskDef(template);
    expect(td).toBeDefined();
    expect(td.Properties.Cpu).toBe('256');
    expect(td.Properties.Memory).toBe('512');
    const worker = td.Properties.ContainerDefinitions.find((c: any) => c.Name === 'worker');
    // Same image as the app — the worker bundle ships inside it; the distroless
    // ENTRYPOINT is `node`, so the command override is just the bundle path.
    expect(worker.Image).toBe(CONTEXT.appImageTag);
    expect(worker.Command).toEqual(['worker.cjs']);
    // No listener, no target group, no ports — the worker serves no traffic.
    expect(worker.PortMappings).toBeUndefined();
  });

  test(`worker (${mode}): SUPABASE_URL env + service-role/SimpleTexting SECRETS + awslogs`, () => {
    const { template } = make();
    const td = findWorkerTaskDef(template);
    const worker = td.Properties.ContainerDefinitions.find((c: any) => c.Name === 'worker');
    expect(worker.Environment).toEqual(
      expect.arrayContaining([{ Name: 'SUPABASE_URL', Value: CONTEXT.supabaseUrl }]),
    );
    expect(worker.Secrets).toEqual(
      expect.arrayContaining([
        {
          Name: 'SUPABASE_SERVICE_ROLE_KEY',
          ValueFrom: `${SERVICE_ROLE_SECRET_ARN}:SERVICE_ROLE_KEY::`,
        },
        {
          Name: 'SIMPLETEXTING_API_TOKEN',
          ValueFrom: `${SMS_SECRETS_ARN}:SIMPLETEXTING_API_TOKEN::`,
        },
      ]),
    );
    expect(worker.LogConfiguration.LogDriver).toBe('awslogs');
    expect(worker.LogConfiguration.Options['awslogs-stream-prefix']).toBe(
      'marketinghub-sms-worker',
    );
  });

  test(`worker (${mode}): ONE task, min 0 / max 100 (a deploy never runs two dispatchers)`, () => {
    const { template } = make();
    const svc = findWorkerService(template);
    expect(svc).toBeDefined();
    expect(svc.Properties.LaunchType).toBe('FARGATE');
    expect(svc.Properties.DeploymentConfiguration.MinimumHealthyPercent).toBe(0);
    expect(svc.Properties.DeploymentConfiguration.MaximumPercent).toBe(100);
    // Not attached to any load balancer.
    expect(svc.Properties.LoadBalancers ?? []).toHaveLength(0);
  });

  test(`worker (${mode}): private subnets, no public IP, WorkerSg + internalClientSg`, () => {
    const { template } = make();
    const svc = findWorkerService(template);
    const cfg = svc.Properties.NetworkConfiguration.AwsvpcConfiguration;
    expect(cfg.AssignPublicIp).toBe('DISABLED');
    expect(cfg.Subnets).toEqual(expect.arrayContaining(SUPABASE_PRIVATE_SUBNET_IDS));
    expect(cfg.SecurityGroups).toEqual(
      expect.arrayContaining([SUPABASE_INTERNAL_CLIENT_SG_ID]),
    );
    expect(JSON.stringify(cfg.SecurityGroups)).toContain('WorkerSg');
  });

  test(`worker (${mode}): the WorkerSg accepts NO ingress at all`, () => {
    const { template } = make();
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const entry = Object.entries(sgs).find(([id]) => id.startsWith('WorkerSg'));
    expect(entry).toBeDefined();
    const [, workerSg] = entry as [string, any];
    expect(workerSg.Properties.SecurityGroupIngress ?? []).toHaveLength(0);
    // ...including via standalone ingress resources.
    const ingresses = template.findResources('AWS::EC2::SecurityGroupIngress');
    for (const r of Object.values(ingresses) as any[]) {
      expect(JSON.stringify(r.Properties.GroupId ?? '')).not.toContain('WorkerSg');
    }
  });

  test(`worker (${mode}): the ECR-pull and kms:Decrypt exec-role grants are replicated`, () => {
    // Both taskdefs use fromRegistry(<ecr-uri>) images and CMK-encrypted secrets,
    // so BOTH execution roles need the ECR pull set + kms:Decrypt on the CMK.
    const { template } = make();
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const withEcrPull = policies.filter((p: any) =>
      (p.Properties.PolicyDocument.Statement as any[]).some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return (
          actions.includes('ecr:GetAuthorizationToken') && actions.includes('ecr:BatchGetImage')
        );
      }),
    );
    expect(withEcrPull.length).toBeGreaterThanOrEqual(2);
    const withKmsDecrypt = policies.filter((p: any) =>
      (p.Properties.PolicyDocument.Statement as any[]).some((s) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        return (
          actions.includes('kms:Decrypt') &&
          resources.includes(CONTEXT.supabaseSecretsKmsKeyArn)
        );
      }),
    );
    expect(withKmsDecrypt.length).toBeGreaterThanOrEqual(2);
  });
}

test('worker: optional simpletextingAccountPhone context becomes SIMPLETEXTING_ACCOUNT_PHONE', () => {
  const app = new App({ context: { ...CONTEXT, simpletextingAccountPhone: '+15551234567' } });
  const template = Template.fromStack(new AppStack(app, 'AppWithAccountPhone', { env }));
  const td = findWorkerTaskDef(template);
  const worker = td.Properties.ContainerDefinitions.find((c: any) => c.Name === 'worker');
  expect(worker.Environment).toEqual(
    expect.arrayContaining([{ Name: 'SIMPLETEXTING_ACCOUNT_PHONE', Value: '+15551234567' }]),
  );
});

test('worker: WITHOUT the optional context, no SIMPLETEXTING_ACCOUNT_PHONE env anywhere', () => {
  const { template } = makeApp();
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const td of Object.values(taskDefs) as any[]) {
    for (const c of td.Properties.ContainerDefinitions ?? []) {
      for (const e of c.Environment ?? []) {
        expect(e.Name).not.toBe('SIMPLETEXTING_ACCOUNT_PHONE');
      }
    }
  }
});
