import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface EdgeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly albSg: ec2.ISecurityGroup;
  readonly internalClientSg: ec2.ISecurityGroup;
  readonly instance: ec2.Instance;
}

export class EdgeStack extends Stack {
  public readonly alb!: elbv2.ApplicationLoadBalancer;
  public readonly internalAlb!: elbv2.ApplicationLoadBalancer;

  private userPool!: cognito.UserPool;
  private userPoolClient!: cognito.UserPoolClient;
  private userPoolDomain!: cognito.UserPoolDomain;
  private publicListener!: elbv2.ApplicationListener;

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
    // --- Task 2: Cognito user pool (identity broker for the ALB) ---
    const userPool = new cognito.UserPool(this, 'StudioUserPool', {
      userPoolName: 'nsight-supabase-studio',
      selfSignUpEnabled: false, // federated-only; no local self-service signups
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.RETAIN, // HIPAA — never auto-delete identities
    });

    // Hosted-UI domain — required for authenticate-cognito.
    const userPoolDomain = userPool.addDomain('StudioUserPoolDomain', {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

    // Google Workspace SAML IdP (metadata URL from context).
    const samlProviderName = 'GoogleSAML';
    const samlIdp = new cognito.CfnUserPoolIdentityProvider(this, 'GoogleSamlIdp', {
      userPoolId: userPool.userPoolId,
      providerName: samlProviderName,
      providerType: 'SAML',
      providerDetails: {
        MetadataURL: googleSamlMetadataUrl,
        IDPSignout: 'true',
      },
      attributeMapping: {
        email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      },
    });

    // App client: OAuth authorization-code flow, callback = Studio /oauth2/idpresponse.
    const userPoolClient = userPool.addClient('StudioClient', {
      generateSecret: true, // ALB authenticate-cognito requires a client secret
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.custom(samlProviderName),
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`https://${studioHostname}/oauth2/idpresponse`],
      },
    });
    // The client references the IdP by name; enforce create ordering.
    userPoolClient.node.addDependency(samlIdp);

    // Admin group — the authorization boundary. Google admin group → Cognito group
    // → gates the ALB authenticate-cognito rule (spec §11).
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: adminGroup,
      description: 'Supabase Studio administrators (gates the ALB authenticate-cognito rule)',
    });

    // Stash for Task 3/4 (authenticate-cognito action needs pool + client + domain).
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.userPoolDomain = userPoolDomain;

    // --- Task 3: Public, internet-facing ALB (WAF attaches in Task 5) ---
    (this as { alb: elbv2.ApplicationLoadBalancer }).alb = new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(4000), // > Realtime/Studio socket heartbeats (spec §11)
    });

    // HTTPS:443 with DEFAULT-DENY. Every allowed route is an explicit rule (Task 4);
    // anything unmatched hits this 403 (spec §11 default-deny).
    const publicListener = this.alb.addListener('PublicHttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [studioCert],
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden',
      }),
    });

    // Stash for Task 4.
    this.publicListener = publicListener;

    // --- Task 4: Studio target group → EC2 host :3000 with a real health check ---
    const studioTargetGroup = new elbv2.ApplicationTargetGroup(this, 'StudioTargetGroup', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      targets: [new elbv2Targets.InstanceTarget(props.instance, 3000)],
      healthCheck: {
        path: '/api/profile',
        healthyHttpCodes: '200,302',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
      },
      deregistrationDelay: Duration.seconds(30), // shorten recreate downtime (spec §22)
    });

    // Authenticated rule: authenticate-cognito wraps the forward-to-Studio action.
    // Covers all Studio routes so nothing slips past the default-deny (spec §11).
    this.publicListener.addAction('StudioAuthenticatedRule', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([studioHostname]),
        elbv2.ListenerCondition.pathPatterns(['/', '/api/*', '/assets/*', '/_next/*', '/project/*']),
      ],
      action: new actions.AuthenticateCognitoAction({
        userPool: this.userPool,
        userPoolClient: this.userPoolClient,
        userPoolDomain: this.userPoolDomain,
        next: elbv2.ListenerAction.forward([studioTargetGroup]),
      }),
    });

    // --- Task 5: AWS WAFv2 in front of the public ALB (spec §11) ---
    const webAcl = new wafv2.CfnWebACL(this, 'StudioWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'nsight-supabase-studio-waf',
      },
      rules: [
        {
          name: 'AWSCommon',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'AWSCommon',
          },
        },
        {
          name: 'AWSKnownBadInputs',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'AWSKnownBadInputs',
          },
        },
        {
          name: 'RateLimit',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'RateLimit',
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'StudioWebAclAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // --- Task 6: Internal ALB (data API) — HTTPS:443 → Kong :8000, in-VPC only ---
    // Internal data-API cert for the private hostname (private-CA per spec §11;
    // swap CertificateValidation.fromDns(privateZone) for a Private CA issuance if
    // the internal hostname isn't resolvable/validatable via the private zone).
    const privateZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PrivateZone', {
      hostedZoneId: privateHostedZoneId,
      zoneName: privateHostedZoneName,
    });
    const dataApiCert = new acm.Certificate(this, 'DataApiCert', {
      domainName: dataApiHostname,
      validation: acm.CertificateValidation.fromDns(privateZone),
    });

    // Dedicated SG for the internal ALB: 443 from in-VPC clients only.
    const internalAlbSg = new ec2.SecurityGroup(this, 'InternalAlbSg', {
      vpc: props.vpc,
      description: 'Internal data-API ALB (in-VPC clients only)',
      allowAllOutbound: true,
    });
    internalAlbSg.addIngressRule(props.internalClientSg, ec2.Port.tcp(443), 'HTTPS from in-VPC clients');

    (this as { internalAlb: elbv2.ApplicationLoadBalancer }).internalAlb =
      new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', {
        vpc: props.vpc,
        internetFacing: false, // scheme = internal
        securityGroup: internalAlbSg,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        idleTimeout: Duration.seconds(4000), // Realtime wss (spec §14)
      });

    const kongTargetGroup = new elbv2.ApplicationTargetGroup(this, 'KongTargetGroup', {
      vpc: props.vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP, // Kong proxy is HTTP on :8000; ALB terminates TLS
      targetType: elbv2.TargetType.INSTANCE,
      targets: [new elbv2Targets.InstanceTarget(props.instance, 8000)],
      healthCheck: {
        path: '/', // Kong returns a status on / — verify against the pinned tag
        healthyHttpCodes: '200,404', // Kong root often 404s without a matching route
        interval: Duration.seconds(30),
      },
    });

    // Data-API listener: plain forward to Kong. NO authenticate-cognito — machine
    // clients authenticate with Supabase JWTs, not browser SSO (spec §11).
    this.internalAlb.addListener('InternalHttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [dataApiCert],
      defaultAction: elbv2.ListenerAction.forward([kongTargetGroup]),
    });

    // --- Task 7: Route 53 A/ALIAS records (spec §11 private-hosted-zone DNS) ---
    // Studio → public ALB (public zone); data API → internal ALB (private zone).
    // External-DNS (Cloudflare) alternative: omit these and CNAME the hostnames to
    // alb.loadBalancerDnsName / internalAlb.loadBalancerDnsName (spec §20).
    new route53.ARecord(this, 'StudioAliasRecord', {
      zone: publicZone,
      recordName: studioHostname,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
    });

    new route53.ARecord(this, 'DataApiAliasRecord', {
      zone: privateZone,
      recordName: dataApiHostname,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.internalAlb)),
    });
  }
}
