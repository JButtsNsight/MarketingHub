import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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
