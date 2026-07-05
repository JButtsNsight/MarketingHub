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
