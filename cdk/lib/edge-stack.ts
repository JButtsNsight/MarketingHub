import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as acmpca from 'aws-cdk-lib/aws-acmpca';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
    // Internal data-API cert is issued from an ACM Private CA (spec §11) — a public
    // DNS-validated cert cannot validate against a private hosted zone.
    const dataApiPrivateCaArn = req('dataApiPrivateCaArn');


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
    // Durable edge resource — never auto-delete (plan Conventions / HIPAA).
    studioCert.applyRemovalPolicy(RemovalPolicy.RETAIN);
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

    // Shared S3 bucket for ALB access logs (spec §11 'ALB access logging on';
    // §15 audit trail). SSE-S3 (ELB log delivery does not support a CMK); TLS-only;
    // retained so the request-level audit trail survives a stack delete.
    const accessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Task 3: Public, internet-facing ALB (WAF attaches in Task 5) ---
    (this as { alb: elbv2.ApplicationLoadBalancer }).alb = new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      idleTimeout: Duration.seconds(4000), // > Realtime/Studio socket heartbeats (spec §11)
    });
    // Per-request audit log for the Studio front door (spec §11 / §15).
    this.alb.logAccessLogs(accessLogsBucket, 'public-alb');

    // HTTPS:443 with DEFAULT-DENY. Every allowed route is an explicit rule (Task 4);
    // anything unmatched hits this 403 (spec §11 default-deny).
    const publicListener = this.alb.addListener('PublicHttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [studioCert],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, // TLS 1.3/1.2 only (spec §14 transmission security)
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
        // Bound the privileged Studio (PHI console) session; without this the ALB
        // auth session defaults to 7 days (spec §11 'Set ALB auth SessionTimeout').
        sessionTimeout: Duration.hours(12),
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
    const privateZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PrivateZone', {
      hostedZoneId: privateHostedZoneId,
      zoneName: privateHostedZoneName,
    });
    // Internal data-API cert (spec §11): issued from an ACM Private CA, NOT public
    // DNS validation. The hostname lives in a Route 53 PRIVATE zone; public ACM
    // DNS validation resolves only against public DNS and would never validate
    // (cert stuck PENDING_VALIDATION → EdgeStack deploy hangs then rolls back).
    const dataApiPrivateCa = acmpca.CertificateAuthority.fromCertificateAuthorityArn(
      this, 'DataApiPrivateCa', dataApiPrivateCaArn,
    );
    const dataApiCert = new acm.PrivateCertificate(this, 'DataApiCert', {
      domainName: dataApiHostname,
      certificateAuthority: dataApiPrivateCa,
    });
    // Durable edge resource — never auto-delete (plan Conventions / HIPAA).
    dataApiCert.applyRemovalPolicy(RemovalPolicy.RETAIN);

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
    // Per-request audit log for the PHI data-API front door (spec §11 / §15).
    this.internalAlb.logAccessLogs(accessLogsBucket, 'internal-alb');

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
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, // TLS 1.3/1.2 only on the PHI path (spec §14)
      defaultAction: elbv2.ListenerAction.forward([kongTargetGroup]),
    });

    // The data path is client -> internal ALB -> Kong :8000 on the host. The host SG
    // (ec2Sg, Phase 1) only allows :8000 from internalClientSg, so without this the ALB
    // (its own InternalAlbSg) cannot reach Kong and every data-API request fails at the
    // host SG. Add the ingress as a standalone resource OWNED BY EdgeStack, referencing
    // the host SG id imported from the compute side (an edge that already exists) and the
    // local InternalAlbSg — using instance.connections.allowFrom() here would place the
    // rule on the host SG in NetworkStack and force a Network->Edge dependency cycle (spec §6/§11).
    new ec2.CfnSecurityGroupIngress(this, 'KongFromInternalAlb', {
      groupId: props.instance.connections.securityGroups[0].securityGroupId,
      sourceSecurityGroupId: internalAlbSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 8000,
      toPort: 8000,
      description: 'Internal data-API ALB to Kong :8000',
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
