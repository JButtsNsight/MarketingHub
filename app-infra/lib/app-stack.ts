import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The container port the Next.js standalone server listens on (PORT=3000). */
const APP_PORT = 3000;

/**
 * Wave-8: the pinned Bedrock embedding model for competitor-intel — Titan Text
 * Embeddings V2, 1024-dim (the dimension the `competitor_intel.chunks.embedding`
 * vector(1024) column and HNSW index are built for). Kept in lockstep with
 * web/src/lib/intel/providers.ts DEFAULT_BEDROCK_MODEL_ID: the flag-ON IAM
 * statement below is scoped to EXACTLY this model's foundation-model ARN, so
 * env and IAM can never drift apart.
 */
const BEDROCK_EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/**
 * Wave-8: the exact foundation-model resource ARN for bedrock:InvokeModel.
 * The account field is EMPTY by design — foundation models are AWS-owned
 * resources (arn:aws:bedrock:<region>::foundation-model/<model-id>). The
 * region is pinned to us-east-1 deliberately: it matches the provider's
 * DEFAULT_BEDROCK_REGION fallback, Titan V2's verified In-Region availability,
 * and the account's PrivateLink posture (com.amazonaws.us-east-1.bedrock-runtime).
 */
const BEDROCK_EMBED_MODEL_ARN = `arn:aws:bedrock:us-east-1::foundation-model/${BEDROCK_EMBED_MODEL_ID}`;

/**
 * MarketingHub application front-door stack.
 *
 * TWO selectable front doors, chosen by the boolean `previewMode` context flag:
 *
 *   • previewMode OFF (DEFAULT — production): a public, internet-facing ALB whose
 *     HTTPS:443 listener DEFAULT action is `authenticate-cognito` federated to the
 *     NSight Google Workspace SAML app (the WHOLE app is authenticated, with a
 *     single unauthenticated `/api/health` path exception for the ALB health
 *     check). WAFv2 (REGIONAL) sits in front, ACM issues the cert, and Route53
 *     aliases the hostname to the ALB.
 *
 *   • previewMode ON (internal preview): an INTERNAL ALB in the private subnets
 *     whose HTTP:80 listener forwards straight to the service — NO Cognito/SAML,
 *     NO ACM cert, NO WAF, NO Route53. The app's `PREVIEW_AUTH` shim (see
 *     web/src/lib/auth.ts) stands in for the missing ALB identity, so this private
 *     deployment needs no DNS or SAML wiring at all.
 *
 * In BOTH modes the app runs as an ECS Fargate service in the imported Supabase
 * private subnets; its security group only accepts the container port from the
 * ALB security group.
 */
export class AppStack extends Stack {
  public readonly alb!: elbv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Explicit, default-OFF toggle between the two front doors. Accepts a real
    // boolean (`previewMode: true` in cdk.json context) or the string 'true'
    // (CLI `-c previewMode=true`); anything else — including absent — is
    // production. Both production and preview remain selectable.
    const previewMode =
      this.node.tryGetContext('previewMode') === true ||
      this.node.tryGetContext('previewMode') === 'true';

    // Fail loud on any missing pre-deploy context value (mirrors EdgeStack).
    const req = (k: string): string => {
      const v = this.node.tryGetContext(k) as string | undefined;
      if (!v) throw new Error(`AppStack: required context "${k}" is not set (see plan §Phase 3)`);
      return v;
    };

    // Context required in BOTH modes.
    const appImageTag = req('appImageTag');
    // OPTIONAL: pin the WORKER (SMS dispatcher) image independently of the
    // app. The live app and worker task-defs have drifted apart out-of-band
    // (runbook §9.4 / §10.2-3): deploying with only appImageTag would
    // silently roll the single dispatcher onto the app's image — a different
    // build, with NO deployment circuit breaker on the WorkerService to
    // catch a bad boot. Staged deploy scripts derive this from the LIVE
    // worker task-def at run time. Absent ⇒ the worker follows appImageTag,
    // exactly the pre-Wave-5 behavior (default synth unchanged).
    const workerImageTag =
      (this.node.tryGetContext('workerImageTag') as string | undefined) ??
      appImageTag;
    const supabaseUrl = req('supabaseUrl');
    const supabaseServiceRoleSecretArn = req('supabaseServiceRoleSecretArn');
    // The service-role secret is encrypted with its own dedicated CMK. Because we
    // import the secret by ARN (fromSecretCompleteArn), CDK grants GetSecretValue but
    // does NOT know the CMK, so it can't grant kms:Decrypt — Fargate then fails with
    // "Access to KMS is not allowed". Pass the CMK ARN and grant Decrypt explicitly.
    const supabaseSecretsKmsKeyArn = req('supabaseSecretsKmsKeyArn');
    // SMS campaigns credentials — one JSON secret with the MONDAY_API_TOKEN /
    // SIMPLETEXTING_WEBHOOK_TOKEN / SIMPLETEXTING_API_TOKEN fields (fields may be
    // empty = the feature degrades gracefully, but the secret must exist).
    const smsSecretsArn = req('smsSecretsArn');
    // OPTIONAL (tryGetContext, not req): the SimpleTexting account phone number
    // some accounts must pass as `accountPhone` on POST /messages. Absent = the
    // worker simply omits it.
    const simpletextingAccountPhone = this.node.tryGetContext('simpletextingAccountPhone') as
      | string
      | undefined;
    // OPTIONAL: tracked-link base URL (the app's public origin). Set = campaign
    // creation rewrites message URLs to `<base>/l/<slug>`; absent = link
    // tracking off, messages keep their original URLs.
    const smsLinkBaseUrl = this.node.tryGetContext('smsLinkBaseUrl') as
      | string
      | undefined;
    // OPTIONAL: dispatcher frequency cap (both must be set and > 0 to enable;
    // absent/0 = off — see the engagement-suite migration + worker env docs).
    const smsFreqCapCount = this.node.tryGetContext('smsFreqCapCount') as
      | string
      | undefined;
    const smsFreqCapDays = this.node.tryGetContext('smsFreqCapDays') as
      | string
      | undefined;

    // The Supabase VPC + subnets + internal-client SG (from the Supabase NetworkStack
    // CfnOutputs). Comma-separated lists are split into string[]. The PUBLIC subnets
    // are ONLY needed by the production internet-facing ALB — preview places its
    // INTERNAL ALB in the private subnets, so they are not required in preview mode.
    const supabaseVpcId = req('supabaseVpcId');
    const supabaseVpcAzs = req('supabaseVpcAzs').split(',');
    const supabasePrivateSubnetIds = req('supabasePrivateSubnetIds').split(',');
    const supabaseInternalClientSgId = req('supabaseInternalClientSgId');
    const supabasePublicSubnetIds = previewMode
      ? undefined
      : req('supabasePublicSubnetIds').split(',');

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

    // The imported PRIVATE subnets host the Fargate service in BOTH modes (and the
    // INTERNAL ALB in preview mode). Selected by id off the imported VPC so the
    // synthesized template pins the exact Supabase subnet ids.
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    // --- Security groups: ALB and app service (ALB-only ingress) ---
    // The ALB SG's ingress differs by mode (443 public vs 80 internal) and is added
    // in the per-mode branch below.
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'MarketingHub ALB',
      allowAllOutbound: true,
    });

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc,
      description: 'MarketingHub Fargate service (ALB-only ingress)',
      allowAllOutbound: true,
    });
    // Same-stack ingress (BOTH modes): the app tier only accepts the container port
    // from the ALB SG. Both SGs are owned by THIS stack, so this does not mutate any
    // upstream stack's policy (no cross-stack dependency cycle).
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(APP_PORT), 'App container port from ALB only');

    // --- ECS Fargate service (private subnets, BOTH modes) ---
    const cluster = new ecs.Cluster(this, 'AppCluster', { vpc });

    // The Supabase service-role key — the ONLY secret the app holds. Imported by
    // its COMPLETE ARN so IAM grants resolve to that exact ARN with no "-??????"
    // partial-ARN wildcard; the key never appears in the task def as plaintext
    // (it is delivered via `ecs.Secret`, i.e. a `ValueFrom` ref).
    const supabaseServiceRoleSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SupabaseServiceRoleSecret',
      supabaseServiceRoleSecretArn,
    );

    // The SMS-campaigns credentials secret (runbook §1.7). Encrypted with the
    // SAME dedicated CMK as the service-role secret — mandated by the runbook —
    // so the existing kms:Decrypt grant on that CMK covers this secret too and
    // no new KMS statement is needed.
    const smsSecrets = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SmsSecrets',
      smsSecretsArn,
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
        // Supabase PostgREST + Storage endpoint (public URL of the self-hosted
        // backend). The service-role KEY is a secret (below), never env.
        SUPABASE_URL: supabaseUrl,
        // The app's auth layer queries the ALB public-key endpoint at
        // public-keys.auth.elb.<region>.amazonaws.com and reads AWS_REGION /
        // ALB_REGION to pick the host. Both set to this stack's region.
        AWS_REGION: this.region,
        ALB_REGION: this.region,
        ...(smsLinkBaseUrl ? { SMS_LINK_BASE_URL: smsLinkBaseUrl } : {}),
      },
      secrets: {
        // Delivered to the container from Secrets Manager at task start; adding
        // it here makes CDK grant the task EXECUTION role read on the exact ARN.
        // The secret is JSON ({"SERVICE_ROLE_KEY":"<jwt>"}), so extract that field —
        // without it the container gets the whole JSON blob and PostgREST 401s.
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(
          supabaseServiceRoleSecret,
          'SERVICE_ROLE_KEY',
        ),
        // SMS campaigns: Monday board reads + SimpleTexting webhook auth. Both
        // are JSON fields of the sms-campaigns secret (empty field = feature
        // degrades gracefully; the app never sees the whole JSON blob).
        MONDAY_API_TOKEN: ecs.Secret.fromSecretsManager(smsSecrets, 'MONDAY_API_TOKEN'),
        SIMPLETEXTING_WEBHOOK_TOKEN: ecs.Secret.fromSecretsManager(
          smsSecrets,
          'SIMPLETEXTING_WEBHOOK_TOKEN',
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'marketinghub-web' }),
    });

    // The image comes from private ECR via ContainerImage.fromRegistry(<ecr-uri>),
    // which (unlike fromEcrRepository) does NOT auto-grant the execution role ECR
    // pull rights — so Fargate would fail with CannotPullContainerError. Grant the
    // standard ECR pull set (GetAuthorizationToken must be resource '*').
    taskDef.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      }),
    );
    // Decrypt the service-role secret's dedicated CMK (the key policy delegates
    // Decrypt to account IAM via kms:ViaService=secretsmanager, which is how
    // GetSecretValue decrypts) — otherwise the task can't read the mounted secret.
    taskDef.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [supabaseSecretsKmsKeyArn],
      }),
    );

    // --- Wave-5 (context-flagged, default OFF): app-config secrets --------------
    // Folds the Wave-4 out-of-band task-def drift into the stack. When the
    // OPTIONAL supabaseAppConfigSecretArn context is set, the APP container gets
    //   SUPABASE_JWT_SECRET — flips getUserClient() to per-user JWTs (RLS live,
    //                         runbook §9) and lets /api/realtime/token mint
    //                         browser Realtime tokens;
    //   SUPABASE_ANON_KEY   — the browser Realtime `apikey` (Kong key-auth),
    //                         returned to clients by /api/realtime/token.
    // Both are JSON fields of Secrets Manager `nsight-supabase/app-config`,
    // delivered as ECS `valueFrom` refs (never plaintext env). NEVER add these
    // to the WORKER task-def: the dispatcher must keep service_role/BYPASSRLS
    // semantics (runbook §9.4). Context ABSENT (default) ⇒ this block emits
    // NOTHING and the synthesized template is unchanged.
    const supabaseAppConfigSecretArn = this.node.tryGetContext('supabaseAppConfigSecretArn') as
      | string
      | undefined;
    if (supabaseAppConfigSecretArn) {
      // app-config sits under a DIFFERENT CMK than the service-role/sms secrets,
      // and a by-ARN secret import cannot discover it — without kms:Decrypt on
      // that exact key the task fails at start (ResourceInitializationError).
      // Fail loud rather than synthesize a task-def that cannot start. The
      // staged /tmp/deploy-w5-infra.sh resolves both ARNs live at run time.
      const supabaseAppConfigKmsKeyArn = this.node.tryGetContext('supabaseAppConfigKmsKeyArn') as
        | string
        | undefined;
      if (!supabaseAppConfigKmsKeyArn) {
        throw new Error(
          'AppStack: supabaseAppConfigSecretArn is set but supabaseAppConfigKmsKeyArn is not — ' +
            'the app-config secret is encrypted with its own CMK; pass both (see /tmp/deploy-w5-infra.sh)',
        );
      }
      const appConfigSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'SupabaseAppConfigSecret',
        supabaseAppConfigSecretArn,
      );
      appContainer.addSecret(
        'SUPABASE_JWT_SECRET',
        ecs.Secret.fromSecretsManager(appConfigSecret, 'JWT_SECRET'),
      );
      appContainer.addSecret(
        'SUPABASE_ANON_KEY',
        ecs.Secret.fromSecretsManager(appConfigSecret, 'ANON_KEY'),
      );
      // Wave-6: Logflare query auth for the /logs + /reports consoles
      // (web/src/lib/console/logs.ts sends it as x-api-key through Kong's
      // analytics-v1-api route). Same app-config JSON secret, same rules:
      // valueFrom only, APP container only — NEVER the worker.
      // PREREQUISITE (enforced, not just documented): the
      // LOGFLARE_PRIVATE_ACCESS_TOKEN key must exist in
      // nsight-supabase/app-config before ANY flag-ON deploy — a deploy with
      // the key absent fails task start (ResourceInitializationError) and the
      // circuit breaker rolls the WHOLE stack update back. Two guards keep
      // that from ever happening:
      //   1. the batched apply order (runbook §11.2) runs the staged
      //      /tmp/stage-w6-env.sh — the key's writer — BEFORE the flag-ON W5
      //      infra deploy (its own JWT prerequisite is satisfied by the
      //      earlier W4 env step);
      //   2. /tmp/deploy-w5-infra.sh's preflight machine-checks
      //      has("LOGFLARE_PRIVATE_ACCESS_TOKEN") on app-config and ABORTS
      //      with the seeding instruction when it is missing.
      // Keeping this in cdk means future flag-ON deploys no longer strip the
      // W6 out-of-band task-def secret.
      appContainer.addSecret(
        'LOGFLARE_PRIVATE_ACCESS_TOKEN',
        ecs.Secret.fromSecretsManager(appConfigSecret, 'LOGFLARE_PRIVATE_ACCESS_TOKEN'),
      );
      taskDef.addToExecutionRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [supabaseAppConfigKmsKeyArn],
        }),
      );
    }

    const service = new ecs.FargateService(this, 'AppService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      // serviceSg accepts the container port from the ALB SG (above); internalClientSg
      // membership is what grants the tasks reachability to the Supabase internal
      // data-API ALB (and, via the private hosted zone, its DNS).
      securityGroups: [serviceSg, internalClientSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      minHealthyPercent: 50,
      circuitBreaker: { rollback: true }, // fail a bad rollout fast instead of hanging ~3h
    });

    // Target group → Fargate service on the container port (BOTH modes). IP target
    // type because Fargate uses awsvpc networking. Health check hits /api/health.
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

    // --- Wave-5 (context-flagged, default OFF): browser Realtime bypass ---------
    // enableRealtimeAlb routes /realtime/v1/* on the front-door listener to the
    // Supabase host's Kong (:8000), so the BROWSER — which can only reach the app
    // ALB — can open the Realtime WebSocket at wss://<app-host>/realtime/v1/...
    // Flag ABSENT (default) ⇒ this block synthesizes NOTHING: the template is
    // identical to pre-Wave-5 (tests assert both states). Same construct style as
    // the /l/* engagement-suite bypass: a priority-numbered rule, plain forward.
    //
    // Reachability note: ALB→Kong:8000 ALSO needs the Supabase-host SG to admit
    // AlbSg. That SG belongs to the Supabase stacks and cannot be mutated here
    // (internalClientSg is imported immutable, and the ALB is not a member of it
    // anyway) — the staged /tmp/deploy-w5-infra.sh adds that ingress idempotently
    // at run time, before the deploy.
    const enableRealtimeAlb =
      this.node.tryGetContext('enableRealtimeAlb') === true ||
      this.node.tryGetContext('enableRealtimeAlb') === 'true';

    let realtimeTargetGroup: elbv2.ApplicationTargetGroup | undefined;
    if (enableRealtimeAlb) {
      // The Supabase host comes from the supabaseUrl context (preview:
      // http://10.60.2.224:8000). An IP-mode target group registers literal
      // IPv4 addresses — fail loud on a hostname rather than synthesize a
      // target group that can never register its target.
      const supabaseHostUrl = new URL(supabaseUrl);
      const supabaseHostIp = supabaseHostUrl.hostname;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(supabaseHostIp)) {
        throw new Error(
          `AppStack: enableRealtimeAlb needs an IPv4 host in supabaseUrl (IP target group); ` +
            `got "${supabaseHostIp}" — pass -c supabaseUrl=http://<host-ip>:8000`,
        );
      }
      const supabaseKongPort = supabaseHostUrl.port ? Number(supabaseHostUrl.port) : 8000;

      realtimeTargetGroup = new elbv2.ApplicationTargetGroup(this, 'RealtimeTargetGroup', {
        vpc,
        port: supabaseKongPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        // WebSocket upgrade requires HTTP/1.1 on the target connection — ALB
        // does not carry WS over an HTTP/2 target protocol.
        protocolVersion: elbv2.ApplicationProtocolVersion.HTTP1,
        // IP target: the Supabase host is an EC2 instance addressed by its
        // private IP (instance targets would need the instance id; IP matches
        // how the app already reaches Kong via SUPABASE_URL).
        targetType: elbv2.TargetType.IP,
        targets: [new elbv2Targets.IpTarget(supabaseHostIp)],
        healthCheck: {
          // Kong answers 404 at / (no route matched) — that IS the "Kong is
          // up" signal; a 200 probe would need an apikey'd tenant-health path.
          path: '/',
          healthyHttpCodes: '404',
          interval: Duration.seconds(30),
          timeout: Duration.seconds(10),
        },
        deregistrationDelay: Duration.seconds(30),
      });
      // NOTE: the ALB idle timeout stays at its 60s default — the realtime-js
      // client heartbeats every 25s in both directions, which resets it.
    }

    // --- SMS dispatcher worker (BOTH modes): a second, ALB-less Fargate service ---
    // Same image FAMILY as the app (the esbuild worker bundle ships inside it),
    // pinned independently via workerImageTag because the two have drifted
    // out-of-band; the distroless ENTRYPOINT is `node`, so the command override
    // is just the bundle path. ONE task polls the SMS outbox; minHealthyPercent
    // 0 / maxHealthyPercent 100 makes a deploy STOP the old dispatcher before
    // starting the new one, so two dispatchers never run at once.
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', {
      vpc,
      description: 'MarketingHub SMS dispatcher worker (no ingress - serves no traffic)',
      allowAllOutbound: true,
    });

    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    const workerContainer = workerTaskDef.addContainer('worker', {
      // workerImageTag defaults to appImageTag; deploy scripts MUST pass the
      // live worker image when the two have drifted (see context note above).
      image: ecs.ContainerImage.fromRegistry(workerImageTag),
      command: ['worker.cjs'],
      // NO portMappings: the dispatcher accepts no traffic (poll-only).
      environment: {
        SUPABASE_URL: supabaseUrl,
        // Optional: some SimpleTexting accounts must pass their account phone
        // as `accountPhone` on POST /messages. Omitted entirely when unset.
        ...(simpletextingAccountPhone
          ? { SIMPLETEXTING_ACCOUNT_PHONE: simpletextingAccountPhone }
          : {}),
        // Optional frequency cap (both > 0 to enable; the worker treats
        // absent/0 as off and the claim RPC then behaves pre-cap).
        ...(smsFreqCapCount ? { SMS_FREQ_CAP_COUNT: smsFreqCapCount } : {}),
        ...(smsFreqCapDays ? { SMS_FREQ_CAP_DAYS: smsFreqCapDays } : {}),
      },
      secrets: {
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(
          supabaseServiceRoleSecret,
          'SERVICE_ROLE_KEY',
        ),
        SIMPLETEXTING_API_TOKEN: ecs.Secret.fromSecretsManager(
          smsSecrets,
          'SIMPLETEXTING_API_TOKEN',
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'marketinghub-sms-worker' }),
    });
    // Replicate the app taskdef's execution-role grants (rationale above): the
    // fromRegistry(<ecr-uri>) image needs the standard ECR pull set, and reading
    // the CMK-encrypted secrets needs kms:Decrypt on that CMK.
    workerTaskDef.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      }),
    );
    workerTaskDef.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [supabaseSecretsKmsKeyArn],
      }),
    );

    // --- Wave-8 (context-flagged, default OFF): Bedrock Titan embeddings --------
    // enableBedrockEmbeddings flips the competitor-intel embedding provider from
    // the deterministic stub (CI_EMBED_PROVIDER default 'stub' — zero AWS calls)
    // to real Bedrock Titan V2 calls, on BOTH services:
    //   * WORKER — the ci_embed queue consumer embeds document chunks;
    //   * APP    — semantic search embeds the QUERY in-request (lib/intel/repo.ts
    //              runs providerFromEnv() for /intel/search).
    // Each container gets plaintext env CI_EMBED_PROVIDER=bedrock +
    // CI_EMBED_MODEL_ID (read by web/src/lib/intel/providers.ts — neither value
    // is a secret), and each TASK role (NOT the execution role — the SDK signs
    // with task-role SigV4 creds at run time) gains bedrock:InvokeModel scoped
    // to EXACTLY the pinned Titan model ARN. These are the FIRST task-role
    // policies on either service — no secret is added anywhere, and the WORKER
    // task-def stays secret-frozen (runbook §9.4: never JWT/anon/logflare).
    // Flag ABSENT (default) ⇒ this block emits NOTHING and the synthesized
    // template is byte-identical to Wave 7 (w8-bedrock.test.ts asserts both
    // states). ROLLBACK = redeploy with the flag off/absent: the env reverts
    // and providerFromEnv() falls back to the stub — see /tmp/stage-w8-bedrock.sh
    // and runbook §13 (activation, cost, re-embed, rollback).
    const enableBedrockEmbeddings =
      this.node.tryGetContext('enableBedrockEmbeddings') === true ||
      this.node.tryGetContext('enableBedrockEmbeddings') === 'true';
    if (enableBedrockEmbeddings) {
      // One statement INSTANCE per role — never share a mutable PolicyStatement
      // across two policy documents.
      const invokeTitanStatement = () =>
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: [BEDROCK_EMBED_MODEL_ARN],
        });
      taskDef.addToTaskRolePolicy(invokeTitanStatement());
      workerTaskDef.addToTaskRolePolicy(invokeTitanStatement());
      for (const container of [appContainer, workerContainer]) {
        container.addEnvironment('CI_EMBED_PROVIDER', 'bedrock');
        container.addEnvironment('CI_EMBED_MODEL_ID', BEDROCK_EMBED_MODEL_ID);
      }
    }

    new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTaskDef,
      desiredCount: 1,
      // internalClientSg membership grants the data-API reachability (same as
      // the app); WorkerSg exists only so the worker does NOT share the app's
      // serviceSg (which admits :3000 from the ALB) — it needs NO ingress at all.
      securityGroups: [workerSg, internalClientSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    if (previewMode) {
      // ===================== INTERNAL PREVIEW FRONT DOOR =====================
      // An INTERNAL ALB in the private subnets, plain HTTP:80 forwarding straight
      // to the service. NO Cognito/SAML, NO ACM cert, NO WAF, NO Route53 — the
      // app's PREVIEW_AUTH shim supplies identity, so this private deployment
      // needs no DNS or SAML wiring.
      albSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        'HTTP to the INTERNAL ALB (no public IP; reachable only within the VPC/VPN/peering)',
      );

      (this as { alb: elbv2.ApplicationLoadBalancer }).alb = new elbv2.ApplicationLoadBalancer(
        this,
        'PublicAlb',
        {
          vpc,
          internetFacing: false, // INTERNAL — private IPs only
          securityGroup: albSg,
          vpcSubnets: privateSubnets,
        },
      );

      // Plain HTTP:80 → target group. No authenticate-cognito, no cert, no HTTPS.
      const previewListener = this.alb.addListener('PreviewHttpListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });

      // Wave-5 (flagged): /realtime/v1/* → the Supabase host's Kong. Covers the
      // WebSocket upgrade (GET /realtime/v1/websocket) AND the REST fallback
      // POST /realtime/v1/api/broadcast, so it is NOT method-scoped. With the
      // flag absent (default) preview keeps ZERO listener rules, as always.
      if (realtimeTargetGroup) {
        previewListener.addAction('RealtimeUnauthenticated', {
          priority: 25,
          conditions: [elbv2.ListenerCondition.pathPatterns(['/realtime/v1/*'])],
          action: elbv2.ListenerAction.forward([realtimeTargetGroup]),
        });
      }

      // The app's preview auth shim treats every request as this group. No ALB
      // identity token is issued in this mode, so ALB_ARN is intentionally NOT set
      // (the shim needs no token).
      appContainer.addEnvironment('PREVIEW_AUTH', 'marketing');

      return;
    }

    // ===================== PRODUCTION COGNITO FRONT DOOR =====================
    // (previewMode OFF) Public, internet-facing ALB whose HTTPS:443 listener DEFAULT
    // action authenticates the WHOLE app via Cognito (Google Workspace SAML), fronted
    // by WAFv2, cert from ACM, aliased in Route53.

    const appHostname = req('appHostname');
    const hostedZoneId = req('hostedZoneId');
    const hostedZoneName = req('hostedZoneName');
    const googleSamlMetadataUrl = req('googleSamlMetadataUrl');
    const adminGroup = req('adminGroup');
    const marketingGroup = req('marketingGroup');
    const cognitoDomainPrefix = req('cognitoDomainPrefix');

    // The imported PUBLIC subnets host the internet-facing ALB.
    const publicSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC });

    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from the internet');

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
    // The app's /logout route redirects here after expiring the ALB session cookie.
    appContainer.addEnvironment('COGNITO_LOGOUT_URL', cognitoLogoutUrl);

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

    // Unauthenticated exception #2: SimpleTexting's delivery-report/unsubscribe
    // webhooks POST here from their servers — no Cognito session possible. The
    // route authenticates itself with its `?token=` shared secret (compared via
    // timingSafeEqual, 401 before any storage). Method-scoped to POST so a
    // browser GET on the path still falls through to the Cognito default action.
    listener.addAction('SimpleTextingWebhookUnauthenticated', {
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/webhooks/simpletexting']),
        elbv2.ListenerCondition.httpRequestMethods(['POST']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Unauthenticated exception #3: tracked short links (`/l/<slug>` embedded
    // in campaign SMS) are clicked from recipients' phones — no Cognito
    // session possible. The route resolves app-generated slugs only: unknown
    // → 404, known → 302 to the campaign's target URL. Method-scoped to GET.
    listener.addAction('TrackedLinkUnauthenticated', {
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/l/*']),
        elbv2.ListenerCondition.httpRequestMethods(['GET']),
      ],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });

    // Wave-5 unauthenticated exception #4 (context-flagged, default OFF): the
    // browser Realtime path. /realtime/v1/* forwards to the Supabase host's
    // Kong with NO authenticate-cognito — the WebSocket handshake cannot ride a
    // Cognito redirect; Realtime authenticates itself with the `apikey` query
    // param (Kong key-auth) plus a short-lived user JWT minted by
    // /api/realtime/token and verified by the Realtime service. NOT
    // method-scoped: the same rule must pass the GET websocket upgrade and the
    // REST-fallback POST /realtime/v1/api/broadcast. Priority 25 slots between
    // the webhook (20) and tracked-link (30) exceptions.
    if (realtimeTargetGroup) {
      listener.addAction('RealtimeUnauthenticated', {
        priority: 25,
        conditions: [elbv2.ListenerCondition.pathPatterns(['/realtime/v1/*'])],
        action: elbv2.ListenerAction.forward([realtimeTargetGroup]),
      });
    }

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
