import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { EdgeStack } from '../lib/edge-stack';

const env = { account: '439024109088', region: 'us-east-1' };

const CONTEXT: Record<string, string> = {
  studioHostname: 'supabase-studio.nsightcare.com',
  dataApiHostname: 'supabase-api.internal.nsightcare.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
  hostedZoneName: 'nsightcare.com',
  privateHostedZoneId: 'Z9876543210ZYXWVUTSRQ',
  privateHostedZoneName: 'internal.nsightcare.com',
  googleSamlMetadataUrl: 'https://accounts.google.com/o/saml2/idp?idpid=C00n27oyt&metadata=true',
  adminGroup: 'supabase-admins',
  cognitoDomainPrefix: 'nsight-supabase',
  dataApiPrivateCaArn:
    'arn:aws:acm-pca:us-east-1:439024109088:certificate-authority/12345678-1234-1234-1234-123456789012',
};

// A tiny fixture stack that gives EdgeStack the cross-stack inputs it needs
// (a VPC, an ALB SG, an internal-client SG, and an EC2 instance) without
// depending on the real NetworkStack/ComputeStack. Same shape as the SHARED
// INTERFACE CONTRACT.
function fixtureInputs() {
  const app = new App({ context: CONTEXT });
  const base = new Stack(app, 'Base', { env });
  const vpc = new ec2.Vpc(base, 'Vpc', { maxAzs: 2, natGateways: 1 });
  const albSg = new ec2.SecurityGroup(base, 'AlbSg', { vpc, allowAllOutbound: true });
  const internalClientSg = new ec2.SecurityGroup(base, 'InternalClientSg', { vpc, allowAllOutbound: true });
  const instance = new ec2.Instance(base, 'Instance', {
    vpc,
    instanceType: new ec2.InstanceType('m6i.xlarge'),
    machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  return { app, vpc, albSg, internalClientSg, instance };
}

export function makeEdge() {
  const { app, vpc, albSg, internalClientSg, instance } = fixtureInputs();
  const stack = new EdgeStack(app, 'Edge', { env, vpc, albSg, internalClientSg, instance });
  return { stack, template: Template.fromStack(stack) };
}

test('missing required context fails loud', () => {
  const app = new App(); // no context
  const base = new Stack(app, 'Base', { env });
  const vpc = new ec2.Vpc(base, 'Vpc', { maxAzs: 2, natGateways: 1 });
  const albSg = new ec2.SecurityGroup(base, 'AlbSg', { vpc });
  const internalClientSg = new ec2.SecurityGroup(base, 'InternalClientSg', { vpc });
  const instance = new ec2.Instance(base, 'Instance', {
    vpc,
    instanceType: new ec2.InstanceType('m6i.xlarge'),
    machineImage: ec2.MachineImage.latestAmazonLinux2023(),
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  });
  expect(() => new EdgeStack(app, 'Edge', { env, vpc, albSg, internalClientSg, instance }))
    .toThrow(/required context/);
});

test('creates an ACM certificate for the Studio hostname', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'supabase-studio.nsightcare.com',
    ValidationMethod: 'DNS',
  });
});

test('creates a Cognito user pool, SAML IdP, hosted-UI domain, and admin group', () => {
  const { template } = makeEdge();
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);

  // Google SAML IdP wired to the metadata URL from context.
  template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
    ProviderType: 'SAML',
    ProviderName: 'GoogleSAML',
    ProviderDetails: Match.objectLike({
      MetadataURL: 'https://accounts.google.com/o/saml2/idp?idpid=C00n27oyt&metadata=true',
    }),
  });

  // Admin Cognito group (authorization, not just authentication).
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
    GroupName: 'supabase-admins',
  });
});

test('app client uses OAuth code flow with the Studio idpresponse callback', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlows: Match.arrayWith(['code']),
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: Match.arrayWith(['https://supabase-studio.nsightcare.com/oauth2/idpresponse']),
    SupportedIdentityProviders: Match.arrayWith(['GoogleSAML']),
  });
});

test('public ALB is internet-facing with a raised idle timeout', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internet-facing',
    Type: 'application',
    LoadBalancerAttributes: Match.arrayWith([
      Match.objectLike({ Key: 'idle_timeout.timeout_seconds', Value: '4000' }),
    ]),
  });
});

test('public 443 listener DEFAULT action is a 403 fixed response (default-deny)', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 443,
    Protocol: 'HTTPS',
    DefaultActions: Match.arrayWith([
      Match.objectLike({
        Type: 'fixed-response',
        FixedResponseConfig: Match.objectLike({ StatusCode: '403' }),
      }),
    ]),
  });
});

test('Studio target group targets the instance on port 3000 with a health check', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 3000,
    Protocol: 'HTTP',
    TargetType: 'instance',
    HealthCheckPath: '/api/profile', // a real Studio route that returns 200/302
  });
});

test('a listener RULE authenticates via Cognito then forwards to the Studio target group', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: Match.arrayWith([
      Match.objectLike({ Field: 'host-header' }),
    ]),
    Actions: Match.arrayWith([
      Match.objectLike({ Type: 'authenticate-cognito', Order: 1 }),
      Match.objectLike({ Type: 'forward', Order: 2 }),
    ]),
  });
});

test('a REGIONAL WebACL with managed + rate-based rules is associated to the public ALB', () => {
  const { template } = makeEdge();
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
          RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }),
        }),
      }),
    ]),
  });
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
});

test('EdgeStack exports both ALBs after full build', () => {
  const { stack } = makeEdge();
  expect(stack.alb).toBeDefined();
  expect(stack.internalAlb).toBeDefined();
});

test('internal ALB is scheme=internal', () => {
  const { template } = makeEdge();
  // Two ALBs total; the internal one is scheme "internal".
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
  });
});

test('internal ALB forwards to a target group on Kong port 8000', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 8000,
    TargetType: 'instance',
  });
});

test('internal 443 listener has NO authenticate-cognito action (machine clients)', () => {
  const { template } = makeEdge();
  const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
  const rules = template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');

  // Locate the internal listener by its logical id: default action is a plain
  // forward (no auth) — that is the machine-client data path.
  const internalEntry = Object.entries(listeners).find(([, l]: [string, any]) =>
    (l.Properties.DefaultActions ?? []).some((a: any) => a.Type === 'forward'
      && (a.TargetGroupArn || a.ForwardConfig?.TargetGroups)),
  );
  expect(internalEntry).toBeDefined();
  const [internalLogicalId, internalListener] = internalEntry as [string, any];

  // Its own default actions must not authenticate.
  const defaultHasAuth = (internalListener.Properties.DefaultActions ?? [])
    .some((a: any) => a.Type === 'authenticate-cognito');
  expect(defaultHasAuth).toBe(false);

  // AND no listener RULE attached to the internal listener may authenticate —
  // guards against a future addAction() sneaking auth onto the data path.
  const ruleHasAuth = Object.values(rules).some((r: any) => {
    const listenerRef = r.Properties.ListenerArn?.Ref;
    if (listenerRef !== internalLogicalId) return false;
    return (r.Properties.Actions ?? []).some((a: any) => a.Type === 'authenticate-cognito');
  });
  expect(ruleHasAuth).toBe(false);
});

test('both HTTPS listeners pin a modern TLS 1.3 SSL policy (no default TLS 1.0/1.1)', () => {
  const { template } = makeEdge();
  const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
  const httpsListeners = Object.values(listeners).filter(
    (l: any) => l.Properties.Protocol === 'HTTPS',
  );
  expect(httpsListeners.length).toBe(2);
  for (const l of httpsListeners as any[]) {
    expect(l.Properties.SslPolicy).toBe('ELBSecurityPolicy-TLS13-1-2-2021-06');
  }
});

test('the Cognito auth rule sets an explicit SessionTimeout (not the 7-day default)', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Actions: Match.arrayWith([
      Match.objectLike({
        Type: 'authenticate-cognito',
        AuthenticateCognitoConfig: Match.objectLike({ SessionTimeout: 43200 }),
      }),
    ]),
  });
});

test('both ALBs enable S3 access logging (spec §11 audit trail)', () => {
  const { template } = makeEdge();
  // A dedicated log-delivery bucket exists.
  const buckets = template.findResources('AWS::S3::Bucket');
  expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
  // Every ALB has access_logs.s3.enabled = true.
  const albs = template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer');
  expect(Object.keys(albs).length).toBe(2);
  for (const alb of Object.values(albs) as any[]) {
    const attrs = alb.Properties.LoadBalancerAttributes ?? [];
    const enabled = attrs.some(
      (a: any) => a.Key === 'access_logs.s3.enabled' && a.Value === 'true',
    );
    expect(enabled).toBe(true);
  }
});

test('the internal data-API cert is issued from an ACM Private CA (not DNS-validated)', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'supabase-api.internal.nsightcare.com',
    CertificateAuthorityArn:
      'arn:aws:acm-pca:us-east-1:439024109088:certificate-authority/12345678-1234-1234-1234-123456789012',
  });
});

test('durable ACM certs are RETAINed on stack delete', () => {
  const { template } = makeEdge();
  const certs = template.findResources('AWS::CertificateManager::Certificate');
  expect(Object.keys(certs).length).toBe(2);
  for (const cert of Object.values(certs) as any[]) {
    expect(cert.DeletionPolicy).toBe('Retain');
  }
});

test('two Route 53 A/ALIAS records: Studio → public ALB, data API → internal ALB', () => {
  const { template } = makeEdge();
  template.resourceCountIs('AWS::Route53::RecordSet', 2);
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'supabase-studio.nsightcare.com.',
    Type: 'A',
  });
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'supabase-api.internal.nsightcare.com.',
    Type: 'A',
  });
});
