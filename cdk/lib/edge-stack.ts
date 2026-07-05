import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';

export interface EdgeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly internalClientSg: ec2.ISecurityGroup;
  readonly instance: ec2.Instance;
}

export class EdgeStack extends Stack {
  public readonly alb!: elbv2.ApplicationLoadBalancer;
  public readonly internalAlb!: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const req = (k: string): string => {
      const v = this.node.tryGetContext(k) as string | undefined;
      if (!v) throw new Error(`EdgeStack: required context "${k}" is not set (see plan §Required CDK context)`);
      return v;
    };

    // Fail loud on any missing pre-deploy value (spec §20).
    const studioHostname = req('studioHostname');
    const dataApiHostname = req('dataApiHostname');
    const hostedZoneId = req('hostedZoneId');
    const hostedZoneName = req('hostedZoneName');
    const privateHostedZoneId = req('privateHostedZoneId');
    const privateHostedZoneName = req('privateHostedZoneName');
    const googleSamlMetadataUrl = req('googleSamlMetadataUrl');
    const adminGroup = req('adminGroup');
    const cognitoDomainPrefix = req('cognitoDomainPrefix');

    // Silence unused-locals until later tasks consume them; remove as each is used.
    void dataApiHostname;
    void privateHostedZoneId; void privateHostedZoneName; void googleSamlMetadataUrl;
    void adminGroup; void cognitoDomainPrefix;

    // --- Task 1: ACM certificate for the Studio hostname (DNS-validated) ---
    // Public hosted zone (from attributes, so no live account lookup at synth).
    const publicZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicZone', {
      hostedZoneId,
      zoneName: hostedZoneName,
    });

    // Studio edge cert. If DNS is external (Cloudflare), swap fromDns(publicZone)
    // for a cert with manual validation records (spec §20 external-DNS path).
    const studioCert = new acm.Certificate(this, 'StudioCert', {
      domainName: studioHostname,
      validation: acm.CertificateValidation.fromDns(publicZone),
    });
    void studioCert; void publicZone;
  }
}
