# Supabase on AWS — Phase 1: Foundation + Network — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the CDK project scaffolding and the two base layers — `FoundationStack` (segregated KMS CMKs) and `NetworkStack` (isolated VPC, VPC endpoints, encrypted flow logs, security groups) — as a deployable, test-covered increment.

**Architecture:** AWS CDK v2 (TypeScript) app under `cdk/`. `FoundationStack` creates four customer-managed KMS keys (data, backup, logs, secrets) with rotation and segregated key policies, exported as construct properties. `NetworkStack` consumes the logs key and builds a 2-AZ VPC with one NAT, gateway + interface VPC endpoints (so PHI/secrets/AWS-API traffic and image pulls avoid the public internet), KMS-encrypted VPC flow logs, and the three security groups with exact-port rules from spec §6. Tests use `aws-cdk-lib/assertions` (`Template`) — the CDK-native TDD pattern: assert the synthesized template, watch it fail, add the construct, watch it pass.

**Tech Stack:** Node.js 22 LTS, aws-cdk-lib v2, constructs v10, TypeScript 5, Jest + ts-jest.

**Plan series:** This is Phase 1 of 5 (see the plan intro). Phases 2–5 depend on the construct properties this phase exports (`FoundationStack.dataKey/backupKey/logsKey/secretsKey`, `NetworkStack.vpc/albSg/ec2Sg/internalClientSg`). Keep those names stable.

**Spec:** `docs/superpowers/specs/2026-06-29-supabase-self-hosted-aws-design.md` (v2). Covers spec §6 (Network), §14 (KMS keys — creation + segregated policies), §21 (`FoundationStack`, `NetworkStack`).

**Conventions:**
- All commands run from `cdk/` unless stated.
- Region `us-east-1`, account `439024109088`. Env passed via CDK context, never hardcoded in constructs.
- Keys/buckets/data resources use `RemovalPolicy.RETAIN` (HIPAA — never auto-delete PHI-adjacent infra).
- Commit after every green test.

---

### Task 0: Scaffold the CDK project

**Files:**
- Create: `cdk/package.json`
- Create: `cdk/tsconfig.json`
- Create: `cdk/jest.config.js`
- Create: `cdk/cdk.json`
- Create: `cdk/bin/nsight-supabase.ts`
- Create: `cdk/.gitignore`

- [ ] **Step 1: Create `cdk/package.json`**

```json
{
  "name": "nsight-supabase-cdk",
  "version": "0.1.0",
  "bin": { "nsight-supabase": "bin/nsight-supabase.js" },
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "test": "jest",
    "cdk": "cdk",
    "synth": "cdk synth",
    "deploy": "cdk deploy"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^22.5.0",
    "aws-cdk": "^2.150.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.5.0"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.150.0",
    "constructs": "^10.3.0"
  }
}
```

- [ ] **Step 2: Create `cdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "typeRoots": ["./node_modules/@types"]
  },
  "exclude": ["node_modules", "cdk.out"]
}
```

- [ ] **Step 3: Create `cdk/jest.config.js`**

```js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
};
```

- [ ] **Step 4: Create `cdk/cdk.json`**

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/nsight-supabase.ts",
  "context": {
    "@aws-cdk/core:newStyleStackSynthesis": true,
    "account": "439024109088",
    "region": "us-east-1"
  }
}
```

- [ ] **Step 5: Create `cdk/.gitignore`**

```
node_modules/
cdk.out/
*.js
*.d.ts
!jest.config.js
```

- [ ] **Step 6: Create `cdk/bin/nsight-supabase.ts` (empty app entry — stacks added in later tasks)**

```ts
#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';

const app = new App();
const env = {
  account: app.node.tryGetContext('account') as string,
  region: app.node.tryGetContext('region') as string,
};

// Stacks are wired in Task 6.

app.synth();
```

- [ ] **Step 7: Install and verify the toolchain**

Run: `cd ~/nsight-supabase/cdk && npm install && npx tsc --noEmit && npx jest --passWithNoTests`
Expected: install succeeds; `tsc` exits 0; Jest prints "No tests found ... passWithNoTests" and exits 0.

- [ ] **Step 8: Commit**

```bash
cd ~/nsight-supabase && git add cdk && git commit -m "chore(cdk): scaffold CDK v2 TypeScript project"
```

---

### Task 1: FoundationStack — four segregated KMS CMKs

**Files:**
- Create: `cdk/lib/foundation-stack.ts`
- Test: `cdk/test/foundation-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/foundation-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';

const env = { account: '439024109088', region: 'us-east-1' };

test('creates four rotation-enabled CMKs with retain policy', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::KMS::Key', 4);
  t.allResourcesProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  t.allResources('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
});

test('creates an alias per key', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::KMS::Alias', 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest foundation-stack`
Expected: FAIL — `Cannot find module '../lib/foundation-stack'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// cdk/lib/foundation-stack.ts
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';

export class FoundationStack extends Stack {
  public readonly dataKey: kms.Key;
  public readonly backupKey: kms.Key;
  public readonly logsKey: kms.Key;
  public readonly secretsKey: kms.Key;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const mkKey = (logicalId: string, alias: string, description: string) =>
      new kms.Key(this, logicalId, {
        alias,
        description,
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    this.dataKey = mkKey('DataKey', 'alias/nsight-supabase-data',
      'CMK for EBS volumes and the S3 storage bucket');
    this.backupKey = mkKey('BackupKey', 'alias/nsight-supabase-backup',
      'CMK for AWS Backup vault and pgBackRest/pg_dump S3 backups');
    this.logsKey = mkKey('LogsKey', 'alias/nsight-supabase-logs',
      'CMK for CloudWatch log groups and VPC flow logs');
    this.secretsKey = mkKey('SecretsKey', 'alias/nsight-supabase-secrets',
      'CMK for Secrets Manager secrets');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest foundation-stack`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/foundation-stack.ts cdk/test/foundation-stack.test.ts && git commit -m "feat(foundation): four rotation-enabled KMS CMKs"
```

---

### Task 2: FoundationStack — logs key policy allows the CloudWatch Logs service (spec §14 segregation)

The `logsKey` must let the CloudWatch Logs service principal use it, or encrypted log groups (Task 5) fail to create. This is a scoped grant, not a blanket `kms:*`.

**Files:**
- Modify: `cdk/lib/foundation-stack.ts`
- Test: `cdk/test/foundation-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { Match } from 'aws-cdk-lib/assertions';

test('logs key policy grants the CloudWatch Logs service principal', () => {
  const app = new App();
  const stack = new FoundationStack(app, 'Foundation', { env });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::KMS::Key', {
    KeyPolicy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'logs.us-east-1.amazonaws.com' },
          Action: Match.arrayWith(['kms:Encrypt*', 'kms:Decrypt*']),
        }),
      ]),
    }),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest foundation-stack -t "CloudWatch Logs service"`
Expected: FAIL — no matching statement in any key policy.

- [ ] **Step 3: Add the policy statement to the logs key**

In `foundation-stack.ts`, add the import and, after `this.logsKey` is created, attach the grant:

```ts
import * as iam from 'aws-cdk-lib/aws-iam';
```

```ts
this.logsKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'AllowCloudWatchLogs',
  principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
  actions: [
    'kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*',
    'kms:GenerateDataKey*', 'kms:Describe*',
  ],
  resources: ['*'],
  conditions: {
    ArnLike: {
      'kms:EncryptionContext:aws:logs:arn':
        `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
    },
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest foundation-stack`
Expected: PASS (all foundation tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/foundation-stack.ts cdk/test/foundation-stack.test.ts && git commit -m "feat(foundation): scope logs CMK policy to CloudWatch Logs service"
```

---

### Task 3: NetworkStack — isolated 2-AZ VPC with one NAT

**Files:**
- Create: `cdk/lib/network-stack.ts`
- Test: `cdk/test/network-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/network-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest network-stack`
Expected: FAIL — `Cannot find module '../lib/network-stack'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// cdk/lib/network-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface NetworkStackProps extends StackProps {
  readonly logsKey: kms.IKey;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

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
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest network-stack`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/network-stack.ts cdk/test/network-stack.test.ts && git commit -m "feat(network): isolated 2-AZ VPC with single NAT"
```

---

### Task 4: NetworkStack — VPC endpoints (S3 gateway + interface endpoints)

Keeps image pulls, secrets, KMS, logs, and SSM traffic off the NAT/internet (spec §6).

**Files:**
- Modify: `cdk/lib/network-stack.ts`
- Test: `cdk/test/network-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('has an S3 gateway endpoint and the required interface endpoints', () => {
  const t = makeStacks();
  // 1 gateway (S3) + 6 interface endpoints
  t.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
  t.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest network-stack -t "endpoint"`
Expected: FAIL — `Template has 0 resources with type AWS::EC2::VPCEndpoint`.

- [ ] **Step 3: Add endpoints in the NetworkStack constructor (after the VPC)**

```ts
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
    };
    for (const [id, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(`${id}Endpoint`, {
        service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest network-stack`
Expected: PASS (all network tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/network-stack.ts cdk/test/network-stack.test.ts && git commit -m "feat(network): S3 gateway + interface VPC endpoints"
```

---

### Task 5: NetworkStack — KMS-encrypted VPC flow logs

**Files:**
- Modify: `cdk/lib/network-stack.ts`
- Test: `cdk/test/network-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('VPC flow logs go to an encrypted, retained log group', () => {
  const t = makeStacks();
  t.resourceCountIs('AWS::EC2::FlowLog', 1);
  t.hasResource('AWS::Logs::LogGroup', {
    DeletionPolicy: 'Retain',
    Properties: { RetentionInDays: 90 },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest network-stack -t "flow logs"`
Expected: FAIL — `Template has 0 resources with type AWS::EC2::FlowLog`.

- [ ] **Step 3: Add flow logs (add imports + code after endpoints)**

Add imports at the top of `network-stack.ts`:

```ts
import { RemovalPolicy } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
```

Add after the endpoints loop:

```ts
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.logsKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest network-stack`
Expected: PASS (all network tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/network-stack.ts cdk/test/network-stack.test.ts && git commit -m "feat(network): KMS-encrypted VPC flow logs with 90d retention"
```

---

### Task 6: NetworkStack — three security groups with exact-port rules (spec §6)

**Files:**
- Modify: `cdk/lib/network-stack.ts`
- Test: `cdk/test/network-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { Match } from 'aws-cdk-lib/assertions';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest network-stack -t "SG"`
Expected: FAIL — no matching ingress resources.

- [ ] **Step 3: Add the SGs (expose as construct properties for later phases)**

Add these public fields to the class:

```ts
  public readonly albSg: ec2.SecurityGroup;
  public readonly ec2Sg: ec2.SecurityGroup;
  public readonly internalClientSg: ec2.SecurityGroup;
```

Add after the flow-log code:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest network-stack`
Expected: PASS (all network tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/network-stack.ts cdk/test/network-stack.test.ts && git commit -m "feat(network): ALB/EC2/internal security groups with exact-port rules"
```

---

### Task 7: Wire both stacks into the app entry and verify synth

**Files:**
- Modify: `cdk/bin/nsight-supabase.ts`
- Test: `cdk/test/app.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/app.test.ts
import { execSync } from 'child_process';

test('cdk synth succeeds for all stacks', () => {
  // Runs the app; throws if synth fails. cwd is the cdk/ project root.
  const out = execSync('npx cdk synth --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest app`
Expected: FAIL — synth produces no stacks / app entry has no stacks wired, or the assertion catches an error.

- [ ] **Step 3: Wire the stacks in `bin/nsight-supabase.ts`**

Replace the placeholder comment with:

```ts
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';

const foundation = new FoundationStack(app, 'SupabaseFoundation', { env });
new NetworkStack(app, 'SupabaseNetwork', { env, logsKey: foundation.logsKey });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest app`
Expected: PASS — synth completes without errors.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: `tsc` exits 0; all Jest suites pass.

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/bin/nsight-supabase.ts cdk/test/app.test.ts && git commit -m "feat(cdk): wire Foundation + Network stacks into the app"
```

---

### Task 8: Deploy the base layer and confirm (manual verification gate)

> Deployment is an outward action against account `439024109088`. Confirm with the owner before running `cdk deploy`. `cdk bootstrap` is required once per account/region if not already done for CDK v2.

- [ ] **Step 1: Diff**

Run: `npx cdk diff SupabaseFoundation SupabaseNetwork`
Expected: shows 4 KMS keys/aliases, VPC, 4 subnets, 1 NAT, 7 endpoints, 1 flow log + log group, 3 SGs. No deletions.

- [ ] **Step 2: Deploy (after owner OK)**

Run: `npx cdk deploy SupabaseFoundation SupabaseNetwork --require-approval broadening`
Expected: `CREATE_COMPLETE` for both stacks.

- [ ] **Step 3: Confirm live**

Run: `aws ec2 describe-vpcs --filters Name=cidr,Values=10.60.0.0/16 --query 'Vpcs[].VpcId' --region us-east-1`
Expected: one VPC id returned.

- [ ] **Step 4: Record the outputs** (VPC id, subnet ids, SG ids, key ARNs) for Phase 2–4 context, and stop.

---

## Self-Review (Phase 1)

**Spec coverage:** §6 Network → Tasks 3–6 (VPC, endpoints, flow logs, SGs). §14 key creation + logs-service segregation → Tasks 1–2 (full per-key least-privilege usage policies for the instance role/Backup/S3 are added in Phases 2–3 where those principals exist — noted, not a gap). §21 stack structure (`FoundationStack`, `NetworkStack` + exported properties) → Tasks 1, 3, 7. **No gaps for Phase 1 scope.**

**Placeholder scan:** none — every code/command step is complete. The comment about Kong admin ports is a guardrail, not a placeholder.

**Type consistency:** exported names used consistently — `FoundationStack.dataKey/backupKey/logsKey/secretsKey` and `NetworkStack.vpc/albSg/ec2Sg/internalClientSg`; `NetworkStackProps.logsKey` matches the `makeStacks()` wiring and Task 7. These are the names Phases 2–5 will import.
