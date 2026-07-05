import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cognito from 'aws-cdk-lib/aws-cognito';

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

    // Silence unused-locals until later tasks consume them; remove as each is used.
    void dataApiHostname;
    void privateHostedZoneId; void privateHostedZoneName;

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
    void publicZone;

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
    void this.userPool; void this.userPoolClient; void this.userPoolDomain;

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
    void this.publicListener;
  }
}
