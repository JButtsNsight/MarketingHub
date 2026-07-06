import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/** The container port the Next.js standalone server listens on (PORT=3000). */
const APP_PORT = 3000;

/**
 * MarketingHub application front-door stack.
 *
 * Reuses the EdgeStack (Supabase Phase 4) front-door pattern: a public,
 * internet-facing ALB whose HTTPS:443 listener is gated by `authenticate-cognito`
 * federated to the NSight Google Workspace SAML app. Unlike EdgeStack (which
 * authenticates a host+path rule and default-denies everything else), here the
 * WHOLE app is authenticated via the listener DEFAULT action, with a single
 * unauthenticated `/api/health` path exception for the ALB health check.
 *
 * The app itself runs as an ECS Fargate service in private subnets; its security
 * group only accepts traffic from the ALB security group. WAFv2 (REGIONAL) sits
 * in front, and Route53 aliases the hostname to the ALB.
 */
export class AppStack extends Stack {
  public readonly alb!: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Fail loud on any missing pre-deploy context value (mirrors EdgeStack).
    const req = (k: string): string => {
      const v = this.node.tryGetContext(k) as string | undefined;
      if (!v) throw new Error(`AppStack: required context "${k}" is not set (see plan §Phase 3)`);
      return v;
    };

    const appHostname = req('appHostname');
    const hostedZoneId = req('hostedZoneId');
    const hostedZoneName = req('hostedZoneName');
    const googleSamlMetadataUrl = req('googleSamlMetadataUrl');
    const adminGroup = req('adminGroup');
    const marketingGroup = req('marketingGroup');
    const cognitoDomainPrefix = req('cognitoDomainPrefix');
    const appImageTag = req('appImageTag');
    const supabaseUrl = req('supabaseUrl');
    const supabaseServiceRoleSecretArn = req('supabaseServiceRoleSecretArn');

    // The Supabase VPC + subnets + internal-client SG (from the Supabase NetworkStack
    // CfnOutputs). Comma-separated lists are split into string[].
    const supabaseVpcId = req('supabaseVpcId');
    const supabaseVpcAzs = req('supabaseVpcAzs').split(',');
    const supabasePublicSubnetIds = req('supabasePublicSubnetIds').split(',');
    const supabasePrivateSubnetIds = req('supabasePrivateSubnetIds').split(',');
    const supabaseInternalClientSgId = req('supabaseInternalClientSgId');

    // --- Networking: run INSIDE the Supabase VPC (do NOT create one) ---
    // The app's data path is Fargate task -> Supabase internal data-API ALB, whose SG
    // only admits the Supabase `internalClientSg`, and the data-API hostname
    // (`SUPABASE_URL`) resolves only in the Supabase PRIVATE hosted zone. Both require
    // the tasks to live in the Supabase VPC — so we import it (no VPC/NAT of our own;
    // fromVpcAttributes needs no account lookup at synth).
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'SupabaseVpc', {
      vpcId: supabaseVpcId,
      availabilityZones: supabaseVpcAzs,
      publicSubnetIds: supabasePublicSubnetIds,
      privateSubnetIds: supabasePrivateSubnetIds,
    });

    // Membership in this SG is what grants the tasks reachability to the Supabase
    // internal data-API ALB (its ingress admits internalClientSg only). Imported
    // immutable — this stack must never mutate the upstream NetworkStack's SG.
    const internalClientSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'InternalClientSg',
      supabaseInternalClientSgId,
      { mutable: false },
    );

    // The imported PUBLIC subnets host the internet-facing ALB; the imported PRIVATE
    // subnets host the Fargate service. Selected by id off the imported VPC so the
    // synthesized template pins the exact Supabase subnet ids.
    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC });
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // --- ACM certificate for the app hostname (public DNS validation) ---
    const publicZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicZone', {
      hostedZoneId,
      zoneName: hostedZoneName,
    });
    const cert = new acm.Certificate(this, 'AppCert', {
      domainName: appHostname,
      validation: acm.CertificateValidation.fromDns(publicZone),
    });
    cert.applyRemovalPolicy(RemovalPolicy.RETAIN); // durable edge resource

    // --- Cognito: identity broker for the ALB (Google Workspace SAML) ---
    const userPool = new cognito.UserPool(this, 'AppUserPool', {
      userPoolName: 'nsight-marketinghub',
      selfSignUpEnabled: false, // federated-only; no local signups
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.RETAIN, // never auto-delete identities
    });

    const userPoolDomain = userPool.addDomain('AppUserPoolDomain', {
      cognitoDomain: { domainPrefix: cognitoDomainPrefix },
    });

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

    const userPoolClient = userPool.addClient('AppClient', {
      generateSecret: true, // ALB authenticate-cognito requires a client secret
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.custom(samlProviderName),
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${appHostname}/oauth2/idpresponse`],
        // Where the Cognito Hosted-UI /logout endpoint redirects the browser
        // AFTER clearing the Cognito/SAML session. The app's /logout route hits
        // the Hosted-UI logout with this as `logout_uri`; Cognito rejects any
        // logout_uri not registered here. Landing on the app root re-triggers
        // the ALB auth flow (i.e. a clean signed-out state).
        logoutUrls: [`https://${appHostname}/`],
      },
    });
    userPoolClient.node.addDependency(samlIdp); // client references the IdP by name

    // The fully-formed Cognito Hosted-UI logout URL the app's /logout route
    // redirects to (after expiring the ALB session cookie). Passed to the
    // container as env so the app owns no Cognito config of its own.
    const postLogoutRedirect = `https://${appHostname}/`;
    const cognitoLogoutUrl =
      `https://${cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com/logout` +
      `?client_id=${userPoolClient.userPoolClientId}` +
      `&logout_uri=${encodeURIComponent(postLogoutRedirect)}`;

    // The two authorization boundaries: admins + marketing staff. Google groups
    // map to these Cognito groups; app-layer authz reads `cognito:groups`.
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: adminGroup,
      description: 'MarketingHub administrators',
    });
    new cognito.CfnUserPoolGroup(this, 'MarketingGroup', {
      userPoolId: userPool.userPoolId,
      groupName: marketingGroup,
      description: 'MarketingHub marketing staff (template authors/browsers)',
    });

    // --- ALB access-log bucket (retained, SSE-S3, TLS-only, no public access) ---
    const accessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // ELB log delivery cannot use a CMK
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --- Security groups: ALB (public 443) and app service (ALB-only) ---
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'MarketingHub public ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from the internet');

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'MarketingHub Fargate service (ALB-only ingress)',
      allowAllOutbound: true,
    });
    // Same-stack ingress: the app tier only accepts the container port from the
    // ALB SG. Both SGs are owned by THIS stack, so this does not mutate any
    // upstream stack's policy (no cross-stack dependency cycle).
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(APP_PORT), 'App container port from ALB only');

    // --- ECS Fargate service (private subnets) ---
    const cluster = new ecs.Cluster(this, 'AppCluster', { vpc });

    // The Supabase service-role key — the ONLY secret the app holds. Imported by
    // its COMPLETE ARN so IAM grants (below) resolve to that exact ARN with no
    // "-??????" partial-ARN wildcard; the key never appears in the task def as
    // plaintext (it is delivered via `ecs.Secret`, i.e. a `ValueFrom` ref).
    const supabaseServiceRoleSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SupabaseServiceRoleSecret',
      supabaseServiceRoleSecretArn,
    );

    const taskDef = new ecs.FargateTaskDefinition(this, 'AppTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const appContainer = taskDef.addContainer('app', {
      image: ecs.ContainerImage.fromRegistry(appImageTag),
      portMappings: [{ containerPort: APP_PORT }],
      environment: {
        PORT: String(APP_PORT),
        NEXT_PUBLIC_APP_NAME: 'MarketingHub',
        COGNITO_LOGOUT_URL: cognitoLogoutUrl,
        // Supabase PostgREST + Storage endpoint (public URL of the self-hosted
        // backend). The service-role KEY is a secret (below), never env.
        SUPABASE_URL: supabaseUrl,
        // The app's auth layer queries the ALB public-key endpoint at
        // public-keys.auth.elb.<region>.amazonaws.com and reads AWS_REGION /
        // ALB_REGION to pick the host. Both set to this stack's region.
        AWS_REGION: this.region,
        ALB_REGION: this.region,
      },
      secrets: {
        // Delivered to the container from Secrets Manager at task start; adding
        // it here makes CDK grant the task EXECUTION role read on the exact ARN.
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(
          supabaseServiceRoleSecret,
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'marketinghub-web' }),
    });

    const service = new ecs.FargateService(this, 'AppService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      // serviceSg accepts the container port from the ALB SG (below); internalClientSg
      // membership is what grants the tasks reachability to the Supabase internal
      // data-API ALB (and, via the private hosted zone, its DNS).
      securityGroups: [serviceSg, internalClientSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      minHealthyPercent: 50,
      circuitBreaker: { rollback: true }, // fail a bad rollout fast instead of hanging ~3h
    });

    // --- Public, internet-facing ALB ---
    (this as { alb: elbv2.ApplicationLoadBalancer }).alb = new elbv2.ApplicationLoadBalancer(
      this,
      'PublicAlb',
      {
        vpc,
        internetFacing: true,
        securityGroup: albSg,
        vpcSubnets: publicSubnets,
      },
    );
    this.alb.logAccessLogs(accessLogsBucket, 'public-alb');

    // REQUIRED for auth: the app verifies the ALB `x-amzn-oidc-data` JWT and
    // asserts its `signer` equals ALB_ARN — a token arriving with ALB_ARN unset
    // makes getUser() throw (fail-loud). Set now that the ALB exists (a Ref to
    // this same stack's load balancer, so no cross-stack dependency).
    appContainer.addEnvironment('ALB_ARN', this.alb.loadBalancerArn);

    // Target group → Fargate service on the container port. IP target type
    // because Fargate uses awsvpc networking. Health check hits the
    // unauthenticated /api/health route.
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AppTargetGroup', {
      vpc,
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [service.loadBalancerTarget({ containerName: 'app', containerPort: APP_PORT })],
      healthCheck: {
        path: '/api/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // HTTPS:443 — DEFAULT action authenticates the WHOLE app via Cognito, then
    // forwards. Modern TLS only (RECOMMENDED_TLS).
    const listener = this.alb.addListener('PublicHttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [cert],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: new actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        sessionTimeout: Duration.hours(12), // bound the SSO session (not the 7-day default)
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });

    // Unauthenticated exception: the ALB health check (and any external uptime
    // probe) must reach /api/health WITHOUT the Cognito redirect. Higher-priority
    // rule → plain forward, no auth.
    listener.addAction('HealthCheckUnauthenticated', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/health'])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // --- WAFv2 (REGIONAL) in front of the ALB ---
    const webAcl = new wafv2.CfnWebACL(this, 'AppWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'marketinghub-web-waf',
      },
      rules: [
        {
          name: 'AWSCommon',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // Scoped overrides for the app's CORE data path. POST /api/templates
              // sends the ENTIRE template inline in the JSON body, so realistic
              // marketing/email HTML (routinely >8 KB, full of markup) would be
              // 403'd at the WAF edge by two CommonRuleSet rules if left at their
              // default Block. Downgrade JUST these two to Count (still logged +
              // metered, never blocking):
              //   - SizeRestrictions_BODY: blocks any body over the 8 KB inspected
              //     limit — kills legitimate large campaign HTML uploads.
              //   - CrossSiteScripting_BODY: matches <script>/on*/javascript: in the
              //     body — false-positives on legit email markup. This adds no real
              //     protection here: stored HTML is only ever rendered in a locked
              //     `<iframe sandbox="">` preview (TemplatePreview.tsx), never executed.
              // Every OTHER CommonRuleSet rule keeps its default Block action.
              ruleActionOverrides: [
                { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
                { name: 'CrossSiteScripting_BODY', actionToUse: { count: {} } },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSCommon',
          },
        },
        {
          name: 'AWSKnownBadInputs',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSKnownBadInputs',
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
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'AppWebAclAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // --- Route 53 A/ALIAS: app hostname → public ALB ---
    new route53.ARecord(this, 'AppAliasRecord', {
      zone: publicZone,
      recordName: appHostname,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
    });
  }
}
