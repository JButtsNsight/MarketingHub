# Supabase on AWS — Phase 4: Edge (public ALB + WAF + Cognito/Google-SAML, internal data-API ALB, DNS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `EdgeStack` — the front door — as a deployable, test-covered increment: a public internet-facing ALB whose HTTPS:443 listener **defaults to deny (403)** and only forwards to Studio (`:3000`) through an `authenticate-cognito` rule backed by a Cognito User Pool federated to the NSight Google Workspace **SAML** app and gated to an admin Cognito group; AWS WAFv2 (managed rule sets + rate limit) in front; and a **separate internal, TLS-terminating ALB** that reaches Kong (`:8000`) so the PHI-bearing data API is encrypted in transit but never public. Route 53 records point the Studio hostname at the public ALB and the data-API hostname at the internal ALB.

**Architecture:** AWS CDK v2 (TypeScript) app under `cdk/`. `EdgeStack` consumes `NetworkStack.{vpc, albSg}` and `ComputeStack.instance` (an `ec2.Instance`) and creates: an ACM certificate for the Studio hostname (DNS-validated against a Route 53 hosted zone looked up from context, with a documented manual-validation fallback for external/Cloudflare DNS); a Cognito User Pool + Hosted-UI domain + a Google **SAML** IdP (`CfnUserPoolIdentityProvider`, `ProviderType: 'SAML'`, `MetadataURL` from context) + a code-flow app client whose callback is `https://<studioHostname>/oauth2/idpresponse` + a `CfnUserPoolGroup` for the admin group; a public `alb` (`internetFacing: true`) in the public subnets with `albSg`, an HTTPS:443 listener whose **default action is `ListenerAction.fixedResponse(403, …)`**, and an authenticated listener **rule** wrapping the forward-to-Studio action (`AuthenticateCognitoAction`) matched on the Studio host and paths (`/`, `/api/*`, assets); a `wafv2.CfnWebACL` (scope `REGIONAL`) + `CfnWebACLAssociation` to the public ALB; an internal `internalAlb` (`internetFacing: false`) in the private subnets with an HTTPS:443 listener (ACM cert) forwarding **without any Cognito action** to Kong (`:8000`), reachable only from `internalClientSg`; and Route 53 A/ALIAS records. Tests use `aws-cdk-lib/assertions` (`Template`) — assert the synthesized template, watch it fail, add the construct, watch it pass.

**Tech Stack:** Node.js 22 LTS, aws-cdk-lib v2 (^2.150), constructs v10, TypeScript 5, Jest + ts-jest. Edge constructs from `aws-cdk-lib/aws-elasticloadbalancingv2`, `aws-cdk-lib/aws-elasticloadbalancingv2-actions`, `aws-cdk-lib/aws-cognito`, `aws-cdk-lib/aws-wafv2`, `aws-cdk-lib/aws-certificatemanager`, `aws-cdk-lib/aws-route53`, `aws-cdk-lib/aws-route53-targets`.

**Plan series:** This is Phase 4 of 5. It depends on properties earlier phases export and must not rename them:
- `NetworkStack.vpc` (`ec2.Vpc`), `NetworkStack.albSg` (`ec2.SecurityGroup`), `NetworkStack.internalClientSg` (`ec2.SecurityGroup`) — Phase 1.
- `ComputeStack.instance` (`ec2.Instance`) — Phase 3.

This phase **defines and exports** exactly `EdgeStack.alb: elbv2.ApplicationLoadBalancer` (public) and `EdgeStack.internalAlb: elbv2.ApplicationLoadBalancer` (internal). Keep those names stable for Phase 5 / observability wiring.

**Spec:** `docs/superpowers/specs/2026-06-29-supabase-self-hosted-aws-design.md` (v2). Covers spec §11 (front door & auth: public ALB + WAF + Cognito/Google-SAML with default-deny listener + admin-group authz + callback enumeration + raised idle timeout; Kong Admin loopback-only; internal TLS ALB for the data API on Kong `:8000`; private-hosted-zone DNS), §14 (TLS in transit at the edge **and** internal), §21 (`EdgeStack`), §20 (open items: DNS provider + hostname, ACM cert, Cognito↔Google-SAML callbacks, admin Google group).

**Conventions:**
- All commands run from `cdk/` unless stated.
- Region `us-east-1`, account `439024109088`. **All environment-specific values come from CDK context, never hardcoded in constructs.**
- Durable/edge resources (Cognito User Pool, ACM cert) use `RemovalPolicy.RETAIN` where a removal policy applies (HIPAA — never auto-delete auth/identity infra).
- Commit after every green test.

**Required CDK context (read in the constructor; see the §20-style note at the end — these are the Phase-4 pre-deploy blockers):**
- `studioHostname` — public FQDN for Studio, e.g. `supabase-studio.nsightcare.com`.
- `dataApiHostname` — private FQDN for the data API, e.g. `supabase-api.internal.nsightcare.com`.
- `hostedZoneId` + `hostedZoneName` — the **public** Route 53 hosted zone for the Studio record + ACM DNS validation (omit / document the manual path if DNS is external/Cloudflare).
- `privateHostedZoneId` + `privateHostedZoneName` — the **private** Route 53 hosted zone for the data-API record.
- `googleSamlMetadataUrl` — the NSight Google Workspace SAML app metadata URL (spec §11 / §20).
- `adminGroup` — the admin Cognito/Google group name gating Studio (spec §11 / §20).
- `cognitoDomainPrefix` — Hosted-UI domain prefix (Cognito requires a domain for `authenticate-cognito`).

Read them once at the top of the constructor with a fail-loud helper so a missing value stops synth rather than deploying a broken front door:

```ts
const req = (k: string): string => {
  const v = this.node.tryGetContext(k) as string | undefined;
  if (!v) throw new Error(`EdgeStack: required context "${k}" is not set (see plan §Required CDK context)`);
  return v;
};
```

---

### Task 0: EdgeStack skeleton + props + context reads

**Files:**
- Create: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/edge-stack.test.ts
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
// (a VPC, an ALB SG, and an EC2 instance) without depending on the real
// NetworkStack/ComputeStack. Same shape as the SHARED INTERFACE CONTRACT.
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

test('EdgeStack synthesizes and exports the two ALBs', () => {
  const { stack } = makeEdge();
  expect(stack.alb).toBeDefined();
  expect(stack.internalAlb).toBeDefined();
});

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
```

> Note: `internalClientSg` is included in props here for realism and used in Task 6; the SHARED INTERFACE CONTRACT lists `{ vpc, albSg, instance }` — we widen it to also accept `internalClientSg` so the internal ALB can be locked to in-VPC clients. This is an additive prop, not a rename.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack`
Expected: FAIL — `Cannot find module '../lib/edge-stack'`.

- [ ] **Step 3: Write the minimal skeleton**

```ts
// cdk/lib/edge-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

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
    void studioHostname; void dataApiHostname; void hostedZoneId; void hostedZoneName;
    void privateHostedZoneId; void privateHostedZoneName; void googleSamlMetadataUrl;
    void adminGroup; void cognitoDomainPrefix; void props;
  }
}
```

> The `void …` lines exist only so `tsc` (with `noUnusedLocals`) stays green while the file is a skeleton. Each subsequent task removes the corresponding `void` as it wires the value in. The `!` on `alb`/`internalAlb` is a definite-assignment assertion; both are assigned in Tasks 3 and 6 before this phase completes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack`
Expected: PASS — both tests (`synthesizes and exports the two ALBs` will pass once `alb`/`internalAlb` are assigned in later tasks; **for now, temporarily assign placeholders** so the export test passes — see Step 5).

- [ ] **Step 5: Temporary placeholder assignments (removed in Tasks 3 & 6)**

Because `alb`/`internalAlb` are declared `readonly` and asserted, assign them the moment they exist (Tasks 3 and 6). To keep Task 0's export test green in isolation, add the public ALB in this task's scope is premature; instead relax the first export test to `it.todo` **only if** you run Task 0 standalone. Practically, implement Tasks 0→6 in sequence and run the export test after Task 6. If you want Task 0 green on its own, drop the export assertions into Task 3 (public) and Task 6 (internal) tests instead. **Recommended: keep the export test but implement through Task 6 before asserting it.** Move the `synthesizes and exports the two ALBs` test to Task 6.

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): EdgeStack skeleton, props, fail-loud context reads"
```

---

### Task 1: ACM certificate for the Studio hostname (DNS-validated)

Public ALB HTTPS needs an ACM cert for `studioHostname` (spec §11, §14). Validate via DNS against the Route 53 public hosted zone looked up from context. If `nsightcare.com` DNS lives outside Route 53 (Cloudflare — spec §20), the cert is created the same way but validation records are added **manually** in the external DNS (documented below).

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { makeEdge } from './edge-stack.test'; // if split; otherwise reuse makeEdge above

test('creates an ACM certificate for the Studio hostname', () => {
  const { template } = makeEdge();
  template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'supabase-studio.nsightcare.com',
    ValidationMethod: 'DNS',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "ACM certificate"`
Expected: FAIL — `Template has 0 resources with type AWS::CertificateManager::Certificate`.

- [ ] **Step 3: Add the hosted-zone lookup + certificate**

Add imports:

```ts
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
```

Add in the constructor (and remove the matching `void` lines):

```ts
    // Public hosted zone (from attributes, so no live account lookup at synth).
    const publicZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicZone', {
      hostedZoneId,
      zoneName: hostedZoneName,
    });

    // Studio edge cert. If DNS is external (Cloudflare), see the manual-validation
    // note in the deploy task — swap fromDns() for the same cert with manual records.
    const studioCert = new acm.Certificate(this, 'StudioCert', {
      domainName: studioHostname,
      validation: acm.CertificateValidation.fromDns(publicZone),
    });
```

Keep `studioCert` and `publicZone` referenced (Tasks 3 and 7 use them; drop their `void` lines).

> **External-DNS (Cloudflare) alternative (spec §20):** if `nsightcare.com` is not in Route 53, omit `PublicZone` and create the cert with `validation: acm.CertificateValidation.fromDns()` (no zone). CDK/CloudFormation then emits the `CNAME` validation record name/value as a stack output; add them by hand in Cloudflare; the stack waits (up to the CFN timeout) until validation completes. Document this switch in the deploy task; the test above still asserts a DNS-validated cert either way.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "ACM certificate"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): DNS-validated ACM cert for Studio hostname"
```

---

### Task 2: Cognito — User Pool + Hosted-UI domain + Google SAML IdP + code-flow app client + admin group

Studio is gated by ALB `authenticate-cognito` → Cognito User Pool federated to the NSight Google Workspace **SAML** app, restricted to a named admin group (spec §11). Cognito needs a Hosted-UI **domain** for `authenticate-cognito` to work.

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { Match } from 'aws-cdk-lib/assertions';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "Cognito"`
Expected: FAIL — no `AWS::Cognito::UserPool` in the template.

- [ ] **Step 3: Add the Cognito resources**

Add import:

```ts
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { RemovalPolicy } from 'aws-cdk-lib';
```

Add in the constructor (drop the matching `void` lines for `googleSamlMetadataUrl`, `adminGroup`, `cognitoDomainPrefix`):

```ts
    // --- Cognito user pool (identity broker for the ALB) ---
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

    // Admin group — the authorization boundary (authenticate-cognito alone lets in
    // anyone in the pool). Google admin group → Cognito group → ALB rule condition.
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: adminGroup,
      description: 'Supabase Studio administrators (gates the ALB authenticate-cognito rule)',
    });

    // Stash for Task 3 (authenticate-cognito action needs pool + client + domain).
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.userPoolDomain = userPoolDomain;
```

Add the private fields to the class (below the public ALB fields):

```ts
  private userPool!: cognito.UserPool;
  private userPoolClient!: cognito.UserPoolClient;
  private userPoolDomain!: cognito.UserPoolDomain;
```

> **Admin-group enforcement note (spec §11):** the `CfnUserPoolGroup` + Google group mapping is the *identity* side. The ALB rule can additionally condition on the group claim, but ALB `authenticate-cognito` does not natively filter by group; the enforced control is (a) Google Workspace only releasing the SAML assertion to members of the admin group, and (b) a Lambda-less path where the Cognito **pre-token / group membership** governs access. For v1, gate membership in Google Workspace + the admin Cognito group and document that broadening requires an explicit group→claim check. This is the §20 "admin Google group" open item — its exact name is `adminGroup` from context.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "Cognito"` then `npx jest edge-stack -t "app client"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): Cognito user pool + Google SAML IdP + code-flow client + admin group"
```

---

### Task 3: Public ALB (internet-facing) + HTTPS:443 listener with default-deny (403)

The public ALB lives in the public subnets, uses `albSg`, and its 443 listener's **default action is a 403 fixed response** (default-deny per spec §11). Raise `idleTimeout` above Realtime/Studio socket heartbeats.

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { Duration } from 'aws-cdk-lib';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "internet-facing"` and `-t "default-deny"`
Expected: FAIL — no load balancer / listener in the template.

- [ ] **Step 3: Add the public ALB + default-deny listener**

Add import:

```ts
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Duration } from 'aws-cdk-lib';
```

(`elbv2` is already imported from Task 0; keep one import.) Assign the exported `alb` and create the listener (drop the `void` for `studioHostname` if not already, and use `studioCert` from Task 1):

```ts
    // --- Public, internet-facing ALB (WAF attaches in Task 5) ---
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
```

Add the private field:

```ts
  private publicListener!: elbv2.ApplicationListener;
```

> The `(this as { alb: … }).alb = …` cast assigns the `readonly` public property from inside the constructor (TS allows readonly assignment in the constructor, but the definite-assignment `!` plus the cast keeps `strict` happy across the split tasks). Simpler alternative: declare `public readonly alb: elbv2.ApplicationLoadBalancer;` and assign `this.alb = …` directly — do that if you build Tasks 0/3 together.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "internet-facing"` and `-t "default-deny"`
Expected: PASS (both). **CRITICAL:** the default action must be the 403 — this is the core security control; do not change it to `forward`/`allow`.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): public internet-facing ALB with default-deny 403 HTTPS listener"
```

---

### Task 4: Studio target group + authenticated listener RULE (authenticate-cognito → forward :3000)

Add a target group to the EC2 `instance` on port 3000 (Studio) with a real health-check path, and an authenticated listener **rule** that wraps the forward action in `AuthenticateCognitoAction`, matched on the Studio host and its paths (`/`, `/api/*`, assets) (spec §11).

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "Studio target group"` and `-t "authenticates via Cognito"`
Expected: FAIL — no target group / listener rule.

- [ ] **Step 3: Add the target group + authenticated rule**

Add imports:

```ts
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
```

Add in the constructor (uses `this.publicListener`, `this.userPool/Client/Domain`, `props.instance`, `studioHostname`):

```ts
    // Studio target group → EC2 host :3000 with a real health check.
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
```

> The EC2-SG already allows `:3000` from `albSg` only (Phase 1, Task 6) — no SG change here. Health-check path `/api/profile` is a Studio route that responds without auth at the app layer; if the pinned Studio tag differs, adjust to a known 200/302 route (verify against the tag at deploy time) — but keep it a **real** path, never `/`-only with a 200 assumption.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "Studio target group"` and `-t "authenticates via Cognito"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): Studio target group + authenticate-cognito forward rule"
```

---

### Task 5: WAFv2 (REGIONAL) — managed rule sets + rate-based rule + association to the public ALB

Put AWS WAF in front of the public ALB (spec §11): AWS managed rule groups + a rate-based rule, associated to `alb`.

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('a REGIONAL WebACL with managed + rate-based rules is associated to the public ALB', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'REGIONAL',
    DefaultAction: { Allow: {} },
    Rules: Match.arrayWith([
      Match.objectLike({
        Statement: Match.objectLike({
          ManagedRuleGroupStatement: Match.objectLike({
            VendorName: 'AWS',
            Name: 'AWSManagedRulesCommonRuleSet',
          }),
        }),
      }),
      Match.objectLike({
        Statement: Match.objectLike({
          RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP' }),
        }),
      }),
    ]),
  });
  template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "REGIONAL WebACL"`
Expected: FAIL — no `AWS::WAFv2::WebACL`.

- [ ] **Step 3: Add the WebACL + association (L1 constructs)**

Add import:

```ts
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
```

Add in the constructor (uses `this.alb`):

```ts
    // --- AWS WAFv2 in front of the public ALB (spec §11) ---
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
```

> Managed-rule-group rules use `overrideAction` (not `action`); the rate-based rule uses `action: { block: {} }`. Mixing these up is the usual WAF L1 mistake — getting it wrong makes CloudFormation reject the ACL.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "REGIONAL WebACL"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): WAFv2 managed + rate-based rules associated to public ALB"
```

---

### Task 6: Internal ALB (data API) — HTTPS:443 → Kong :8000, in-VPC only, NO Cognito

The PHI-bearing data API path must be **encrypted in transit but never public** (spec §11, §14). Build a second, internal ALB in the private subnets, HTTPS:443 with an ACM cert, forwarding to Kong (`:8000`) with **no authenticate-cognito** (machine clients present Supabase JWTs, not browser SSO). Its SG allows only `internalClientSg`. Raise idle timeout for Realtime WebSockets.

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)** — includes the Task 0 export assertion moved here

```ts
test('EdgeStack exports both ALBs after full build', () => {
  const { stack } = makeEdge();
  expect(stack.alb).toBeDefined();
  expect(stack.internalAlb).toBeDefined();
});

test('internal ALB is scheme=internal', () => {
  const { template } = makeEdge();
  // Two ALBs total; the internal one is scheme "internal".
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 2);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
    Scheme: 'internal',
  });
});

test('internal ALB forwards to a target group on Kong port 8000', () => {
  const { template } = makeEdge();
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 8000,
    TargetType: 'instance',
  });
});

test('internal 443 listener has NO authenticate-cognito action (machine clients)', () => {
  const { template } = makeEdge();
  // Assert the internal listener's default action is plain forward, not auth.
  const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
  const internal = Object.values(listeners).find((l: any) =>
    (l.Properties.DefaultActions ?? []).some((a: any) => a.Type === 'forward'
      && a.ForwardConfig?.TargetGroups),
  );
  // No listener default action anywhere should be authenticate-cognito on the data path.
  const hasAuthDefault = Object.values(listeners).some((l: any) =>
    (l.Properties.DefaultActions ?? []).some((a: any) => a.Type === 'authenticate-cognito'),
  );
  expect(hasAuthDefault).toBe(false);
  expect(internal).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "internal ALB"` and `-t "NO authenticate-cognito"`
Expected: FAIL — only one ALB / no port-8000 target group.

- [ ] **Step 3: Add the internal ALB + cert + Kong target group**

The internal listener needs a TLS cert. Per spec §11 the internal path uses an **ACM private-CA** cert; for the buildable v1 use an ACM cert for `dataApiHostname` validated against the **private** zone via the same DNS flow, or (cleaner for a private hostname) an ACM cert issued from an **ACM Private CA**. To keep the plan self-contained and testable, issue an ACM cert for `dataApiHostname` and document the private-CA swap. Add:

```ts
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
```

> **Security-critical:** the internal listener default action is `forward`, never `authenticate-cognito`. The test above asserts no listener anywhere has an `authenticate-cognito` **default** action; the only auth action in the stack is the Studio listener **rule** (Task 4). EC2-SG already allows `:8000` from `internalClientSg` (Phase 1) — the ALB sits between clients and the host, so traffic is client → `internalAlbSg` → ALB → host `:8000` (from `albSg`? No — from the internal ALB's SG). **Add a Phase-3/1 note:** EC2-SG must also allow `:8000` from `internalAlbSg`; since Phase 1 allowed `:8000` from `internalClientSg`, either (a) also target the ALB's SG in EC2-SG, or (b) keep clients hitting Kong directly and use the internal ALB only for the TLS hop. For this plan, the internal ALB is the TLS front; **document that EC2-SG needs an added ingress `:8000` from `internalAlbSg`** — flagged in Self-Review as a cross-phase dependency (do not silently rely on the `internalClientSg` rule covering the ALB).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack`
Expected: PASS (all edge tests, including the moved export assertion).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): internal TLS ALB to Kong :8000, in-VPC only, no Cognito"
```

---

### Task 7: Route 53 records — Studio → public ALB (public zone), data API → internal ALB (private zone)

Point the two hostnames at the two ALBs (spec §11 private-hosted-zone DNS). A/ALIAS `studioHostname` → public `alb`; A/ALIAS `dataApiHostname` → `internalAlb` in the private zone. If DNS is external (Cloudflare), document the manual `CNAME` alternative.

**Files:**
- Modify: `cdk/lib/edge-stack.ts`
- Test: `cdk/test/edge-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('two Route 53 A/ALIAS records: Studio → public ALB, data API → internal ALB', () => {
  const { template } = makeEdge();
  template.resourceCountIs('AWS::Route53::RecordSet', 2);
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'supabase-studio.nsightcare.com.',
    Type: 'A',
  });
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'supabase-api.internal.nsightcare.com.',
    Type: 'A',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest edge-stack -t "Route 53"`
Expected: FAIL — 0 record sets.

- [ ] **Step 3: Add the records**

Add import:

```ts
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
```

Add in the constructor (reuse `publicZone` from Task 1 and `privateZone` from Task 6):

```ts
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
```

> **External-DNS alternative (spec §20):** if the zones aren't in Route 53, omit these `ARecord`s and instead add, in the external DNS provider (Cloudflare), a `CNAME` from `studioHostname` → `alb.loadBalancerDnsName` and from `dataApiHostname` → `internalAlb.loadBalancerDnsName` (the private one requires a split-horizon/internal resolver). Emit both DNS names as `CfnOutput`s so the operator can create the records by hand. The test above asserts Route 53 records; if you go external-DNS, replace it with a test asserting the two `CfnOutput`s exist.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest edge-stack -t "Route 53"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/edge-stack.ts cdk/test/edge-stack.test.ts && git commit -m "feat(edge): Route 53 alias records for Studio and data API"
```

---

### Task 8: Wire EdgeStack into the app entry + full synth

**Files:**
- Modify: `cdk/bin/nsight-supabase.ts`
- Test: `cdk/test/app.test.ts` (extend the existing Phase-1 synth test)

- [ ] **Step 1: Confirm the app-level synth test still guards synth**

The Phase-1 `cdk/test/app.test.ts` already asserts `cdk synth --quiet` produces no error. Extend it (or leave as-is) so it exercises `EdgeStack` too:

```ts
// cdk/test/app.test.ts (extend)
test('synth includes EdgeStack', () => {
  const out = execSync('npx cdk synth SupabaseEdge --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});
```

> `cdk synth SupabaseEdge` will fail unless the required context is supplied. Provide it via `cdk.json` `context` (safe, non-secret hostnames/IDs) **or** `-c key=value` flags in the test's `execSync`. Do **not** commit real secret values; the SAML metadata URL and hostnames are non-secret and belong in `cdk.json` context or a committed `cdk.context.json`.

- [ ] **Step 2: Wire the stack in `bin/nsight-supabase.ts`**

`EdgeStack` needs `vpc`, `albSg`, `internalClientSg` (from `NetworkStack`) and `instance` (from `ComputeStack`). Add after the Phase-1/2/3 stacks:

```ts
import { EdgeStack } from '../lib/edge-stack';

// network = new NetworkStack(...), compute = new ComputeStack(...) from earlier phases
new EdgeStack(app, 'SupabaseEdge', {
  env,
  vpc: network.vpc,
  albSg: network.albSg,
  internalClientSg: network.internalClientSg,
  instance: compute.instance,
});
```

- [ ] **Step 3: Add the non-secret edge context to `cdk.json`**

Add under `context` in `cdk/cdk.json` (fill real values before deploy; see §20 note):

```json
"studioHostname": "supabase-studio.nsightcare.com",
"dataApiHostname": "supabase-api.internal.nsightcare.com",
"hostedZoneId": "REPLACE_ME",
"hostedZoneName": "nsightcare.com",
"privateHostedZoneId": "REPLACE_ME",
"privateHostedZoneName": "internal.nsightcare.com",
"googleSamlMetadataUrl": "REPLACE_ME",
"adminGroup": "supabase-admins",
"cognitoDomainPrefix": "nsight-supabase"
```

- [ ] **Step 4: Full suite + typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: `tsc` exits 0; all suites pass.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/bin/nsight-supabase.ts cdk/cdk.json cdk/test/app.test.ts && git commit -m "feat(cdk): wire EdgeStack into the app + edge context"
```

---

### Task 9: Deploy the edge + verify the front door (manual verification gate)

> Deployment is an outward action against account `439024109088`. **Confirm with the owner before running `cdk deploy`.** This task also has **pre-deploy blockers** (spec §20) that must be resolved first.

- [ ] **Step 1: Resolve the §20 pre-deploy context (blockers)**

Before deploy, the owner must supply the real values for:
1. **DNS provider + Studio hostname + ACM cert** — Route 53 (`hostedZoneId`/`hostedZoneName`, `privateHostedZoneId`/`privateHostedZoneName`) vs Cloudflare (use the external-DNS alternatives in Tasks 1 & 7). Confirm the exact `studioHostname` / `dataApiHostname`.
2. **Google SAML metadata URL** (`googleSamlMetadataUrl`) — the NSight Google Workspace SAML app metadata endpoint (per user memory, single Google Workspace SAML app, idpid `C00n27oyt`).
3. **Admin Google group** (`adminGroup`) — the Google group whose members Google releases the SAML assertion to, mirrored as the Cognito `CfnUserPoolGroup`.
Put all non-secret values in `cdk.json` context; nothing here is a secret.

- [ ] **Step 2: Diff**

Run: `npx cdk diff SupabaseEdge`
Expected: shows 1 ACM cert (+ possibly a second for the data API), 1 Cognito user pool + domain + SAML IdP + client + group, 2 ALBs (1 internet-facing, 1 internal), listeners (public with 403 default), 1 Studio + 1 Kong target group, 1 WebACL + association, 2 Route 53 records. No deletions.

- [ ] **Step 3: Deploy (after owner OK)**

Run: `npx cdk deploy SupabaseEdge --require-approval broadening`
Expected: `CREATE_COMPLETE`. DNS-validated ACM certs may pause until the validation `CNAME`s resolve (auto in Route 53; manual in Cloudflare).

- [ ] **Step 4: Register the remaining callbacks (post-deploy, spec §11)**

Enumerate/confirm every callback in the chain now that names exist:
- ALB → `https://<studioHostname>/oauth2/idpresponse` (created by the rule).
- Cognito app-client callback = `https://<studioHostname>/oauth2/idpresponse` (Task 2).
- Cognito Hosted-UI domain = `<cognitoDomainPrefix>.auth.us-east-1.amazoncognito.com`.
- **Google SAML ACS URL → Cognito** — set in the Google Workspace SAML app: `https://<cognitoDomainPrefix>.auth.us-east-1.amazoncognito.com/saml2/idpresponse` (add in Google admin; this is a manual step, spec §11).

- [ ] **Step 5: Verify the front door (the security acceptance from spec §17)**

- [ ] Unauthenticated Studio root redirects to Cognito (302 to the Hosted-UI / Google), **not** 200:

  Run: `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<studioHostname>/`
  Expected: `302` with a `redirect_url` pointing at `…amazoncognito.com` (authenticate-cognito challenge), or `401`.

- [ ] Unauthenticated **sub-paths** are also gated (no bypass, spec §11 default-deny):

  Run: `for p in /api/profile /assets/x.js /project/default; do curl -sS -o /dev/null -w "%{http_code} $p\n" https://<studioHostname>$p; done`
  Expected: each returns `302`/`401`. An **unmatched** path (e.g. `/nope`) returns `403` (default-deny).

- [ ] The **data API is not reachable publicly** — the internal ALB has no public DNS/route:

  Run (from OUTSIDE the VPC): `curl -sS -m 10 https://<dataApiHostname>/rest/v1/ ; echo "exit=$?"`
  Expected: DNS failure or timeout (private zone / internal scheme). From an **in-VPC** client with a Supabase JWT, the same path returns a REST response over TLS (spec §17 functional check).

- [ ] Kong Admin remains unreachable (spec §11/§17): confirm no target group/listener targets `:8001`/`:8444`/`:8002` (grep the synth output; already guaranteed by the plan — only `:3000` and `:8000` target groups exist).

- [ ] **Step 6: Record outputs** (public ALB DNS, internal ALB DNS, Cognito pool id, Hosted-UI domain, WebACL ARN) for Phase 5 / ObservabilityStack, and stop.

---

## Self-Review (Phase 4)

**Spec coverage:**
- §11 public ALB + WAF → Tasks 3 (public ALB), 5 (WAFv2 + association). Default-deny 403 listener → Task 3 (asserted). Admin-group authz → Task 2 (`CfnUserPoolGroup` + Google-group note). Callback enumeration → Task 2 (client callback) + Task 9 Step 4 (ALB/Hosted-UI/Google ACS). Raised idle timeout → Tasks 3 & 6. Kong Admin loopback-only → not re-created here; guaranteed by only targeting `:3000`/`:8000` (Task 9 verify).
- §11 Studio via `authenticate-cognito` → Cognito → Google SAML → Task 2 (pool + SAML IdP + client) + Task 4 (authenticated rule). "all Studio routes" → Task 4 path patterns.
- §11 internal TLS ALB for the data API on Kong `:8000`, **no Cognito** → Task 6 (asserted: scheme internal, port 8000, no authenticate-cognito default). §11 private-hosted-zone DNS → Task 7.
- §14 TLS at edge **and** internal → Task 1 (edge cert) + Task 6 (internal cert). Realtime `wss` idle timeout → Task 6.
- §21 `EdgeStack` → the whole file; wired in Task 8. §20 open items (DNS provider + hostname, ACM cert, Cognito↔Google callbacks, admin group) → Required-CDK-context note + Task 9 Steps 1 & 4.
- **No gaps for Phase 4 scope.** Out of scope (correctly): pgaudit/RLS (Phase 2/data), ObservabilityStack alarms (Phase 5).

**Placeholder scan:** No unfinished code. `REPLACE_ME` in `cdk.json` (Task 8 Step 3) are deliberate operator-supplied context values, called out as §20 blockers in Task 9 Step 1 — not code placeholders. Health-check paths (`/api/profile`, Kong `/`) are marked "verify against the pinned tag" — real defaults, not stubs.

**Type consistency vs contract:**
- `EdgeStack` in `cdk/lib/edge-stack.ts`, tests `cdk/test/edge-stack.test.ts` — matches contract.
- Props `{ vpc: ec2.IVpc; albSg: ec2.ISecurityGroup; instance: ec2.Instance } & StackProps`, **additively** widened with `internalClientSg: ec2.ISecurityGroup` (needed to lock the internal ALB; documented in Task 0). Not a rename of any existing field.
- Exports exactly `alb: elbv2.ApplicationLoadBalancer` (public) and `internalAlb: elbv2.ApplicationLoadBalancer` (internal) — verbatim contract names/types.
- Consumes `NetworkStack.{vpc, albSg, internalClientSg}` and `ComputeStack.instance` by the exact contract names; imports use the correct v2 paths (`aws-elasticloadbalancingv2`, `-actions`, `aws-cognito`, `aws-wafv2`, `aws-certificatemanager`, `aws-route53`, `aws-route53-targets`).

**Cross-phase dependency flagged (not a Phase-4 gap):** the internal ALB sits between in-VPC clients and Kong; EC2-SG (Phase 1) currently allows `:8000` from `internalClientSg`. For traffic to flow **client → internal ALB → host `:8000`**, EC2-SG must also allow `:8000` from the internal ALB's SG (`InternalAlbSg`, created in Task 6). Resolve by adding that ingress when Phase 1/3 SGs are revisited, or by having the internal ALB's SG be `internalClientSg` itself. Documented in Task 6 Step 3; carry to Phase 5 wiring.

**Security invariants re-checked:** (1) public listener **default action = 403 fixed response** — asserted in Task 3, never changed to forward/allow. (2) The **only** `authenticate-cognito` action is the Studio listener **rule** (Task 4); the internal/data-API listener is a plain `forward` — asserted (`hasAuthDefault === false`) in Task 6. (3) Only `:3000` (Studio) and `:8000` (Kong) target groups exist — Kong Admin ports never targeted (Task 9 verify).
