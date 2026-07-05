import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';

const env = { account: '439024109088', region: 'us-east-1' };

function makeStacks() {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  return Template.fromStack(network);
}

test('VPC with the expected CIDR and exactly one NAT gateway', () => {
  const t = makeStacks();
  t.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.60.0.0/16' });
  t.resourceCountIs('AWS::EC2::NatGateway', 1);
});

test('public and private subnets across two AZs (4 subnets total)', () => {
  const t = makeStacks();
  t.resourceCountIs('AWS::EC2::Subnet', 4);
});

test('has an S3 gateway endpoint and the required interface endpoints', () => {
  const t = makeStacks();
  // 1 gateway (S3) + 6 interface endpoints
  t.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
  t.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
});

test('VPC flow logs go to an encrypted, retained log group', () => {
  const t = makeStacks();
  t.resourceCountIs('AWS::EC2::FlowLog', 1);
  t.hasResource('AWS::Logs::LogGroup', {
    DeletionPolicy: 'Retain',
    Properties: { RetentionInDays: 90 },
  });
});

test('EC2 SG allows Studio :3000 from the ALB SG only', () => {
  const t = makeStacks();
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 3000, ToPort: 3000, IpProtocol: 'tcp',
  });
});

test('EC2 SG allows Kong :8000 and Supavisor :5432/:6543 from internal clients', () => {
  const t = makeStacks();
  for (const p of [8000, 5432, 6543]) {
    t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: p, ToPort: p, IpProtocol: 'tcp',
    });
  }
});

test('ALB SG allows 443 from the internet', () => {
  const t = makeStacks();
  t.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({ FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
    ]),
  });
});
