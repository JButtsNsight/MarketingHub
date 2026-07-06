import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface NetworkStackProps extends StackProps {
  readonly logsKey: kms.IKey;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly ec2Sg: ec2.SecurityGroup;
  public readonly internalClientSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.60.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // VPC endpoints keep PHI/secret/AWS-API traffic and image pulls off the
    // NAT/public internet (spec §6).
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      Kms: ec2.InterfaceVpcEndpointAwsService.KMS,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Ecr: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
      // ssmmessages carries Session Manager's interactive control/data channel
      // (distinct from the ssm API endpoint); without it, SSM Session Manager —
      // the sole host-access path per spec §13 — egresses via NAT/internet,
      // violating §6's "AWS-API traffic never traverses NAT/internet" guarantee.
      SsmMessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
    };
    for (const [id, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${id}Endpoint`, {
        service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // KMS-encrypted, retained VPC flow logs (spec §6/§15).
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.logsKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Security groups with exact-port rules (spec §6).
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc, description: 'Public ALB (WAF in front)', allowAllOutbound: true,
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');

    this.internalClientSg = new ec2.SecurityGroup(this, 'InternalClientSg', {
      vpc: this.vpc, description: 'In-VPC clients of the Supabase data API', allowAllOutbound: true,
    });

    this.ec2Sg = new ec2.SecurityGroup(this, 'Ec2Sg', {
      vpc: this.vpc, description: 'Supabase host', allowAllOutbound: true,
    });
    this.ec2Sg.addIngressRule(this.albSg, ec2.Port.tcp(3000), 'Studio from ALB only');
    this.ec2Sg.addIngressRule(this.internalClientSg, ec2.Port.tcp(8000), 'Kong proxy from internal clients');
    this.ec2Sg.addIngressRule(this.internalClientSg, ec2.Port.tcp(5432), 'Supavisor session pooler');
    this.ec2Sg.addIngressRule(this.internalClientSg, ec2.Port.tcp(6543), 'Supavisor transaction pooler');
    // NOTE: Kong Admin :8001/:8444 and Kong Manager :8002 are intentionally NOT exposed
    // (loopback-only on the host per spec §11). Do not add ingress rules for them.

    // Exports so a SEPARATE app stack (e.g. MarketingHub's AppStack) can run INSIDE
    // this VPC and join `internalClientSg` — the only path to the internal data-API
    // ALB and its private-zone DNS. These are read-only CfnOutputs (no resource impact)
    // that operators copy into the app's `supabase*` context keys. Stable exportNames.
    new CfnOutput(this, 'VpcIdOutput', {
      value: this.vpc.vpcId,
      description: 'Supabase VPC id (app context: supabaseVpcId)',
      exportName: 'SupabaseVpcId',
    });
    new CfnOutput(this, 'PublicSubnetIdsOutput', {
      value: this.vpc.publicSubnets.map((s) => s.subnetId).join(','),
      description: 'Supabase public subnet ids, internet-facing ALB tier (app context: supabasePublicSubnetIds)',
      exportName: 'SupabasePublicSubnetIds',
    });
    new CfnOutput(this, 'PrivateSubnetIdsOutput', {
      value: this.vpc.privateSubnets.map((s) => s.subnetId).join(','),
      description: 'Supabase private (with-egress) subnet ids, Fargate tier (app context: supabasePrivateSubnetIds)',
      exportName: 'SupabasePrivateSubnetIds',
    });
    new CfnOutput(this, 'InternalClientSgIdOutput', {
      value: this.internalClientSg.securityGroupId,
      description: 'Supabase internal-client SG id — in-VPC clients of the data API (app context: supabaseInternalClientSgId)',
      exportName: 'SupabaseInternalClientSgId',
    });
  }
}
