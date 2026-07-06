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
};

/** The exact secret ARN the task consumes — IAM must be scoped to THIS, no wildcard. */
const SERVICE_ROLE_SECRET_ARN = CONTEXT.supabaseServiceRoleSecretArn;

function makeApp() {
  const app = new App({ context: CONTEXT });
  const stack = new AppStack(app, 'App', { env });
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
  // It must be a Secret (ValueFrom), never a plaintext Environment value.
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Secrets: Match.arrayWith([
          Match.objectLike({
            Name: 'SUPABASE_SERVICE_ROLE_KEY',
            ValueFrom: SERVICE_ROLE_SECRET_ARN,
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

test('the execution role may read ONLY the exact service-role secret ARN (no wildcard)', () => {
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
      // Exact ARN string — never a "*" and never the "-??????" partial-ARN glob.
      expect(typeof r).toBe('string');
      expect(r).toBe(SERVICE_ROLE_SECRET_ARN);
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

test('a Route53 A/ALIAS record points the app hostname at the ALB', () => {
  const { template } = makeApp();
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'marketinghub.nsightcare.com.',
    Type: 'A',
  });
});
