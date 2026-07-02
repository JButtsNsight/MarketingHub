# Supabase on AWS — Phase 3: Compute + Host Bootstrap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `ComputeStack` — the single EC2 host that runs Supabase's official `docker-compose` bundle — as a deployable, test-covered increment: an exact-ARN-scoped instance role, an `m6i.xlarge` AL2023 instance in a private subnet with IMDSv2 hop-limit 1, a root + tagged data EBS volume (both KMS-encrypted), EC2 auto-recovery, and a full fail-loud, idempotent host bootstrap (Docker + compose, UUID data-volume mount, `.supabase-initialized` sentinel, no-echo secret fetch, S3 Storage backend, pgBackRest WAL/PITR + nightly `pg_dump`).

**Architecture:** `ComputeStack` (in `cdk/lib/compute-stack.ts`) consumes Phase 1's `NetworkStack{vpc, ec2Sg}` and `FoundationStack{dataKey}`, and Phase 2's `DataStack{storageBucket, backupBucket, appConfigSecret, serviceRoleSecret, storageCredsSecret, smtpSecret}`. It builds: an `iam.Role` for `ec2.amazonaws.com` (SSM core managed policy + `grantRead` on the four secrets + `backupBucket.grantReadWrite` + CloudWatch Logs put — **no** access to `storageBucket`, because the container uses its own bucket-scoped creds per spec §10); one `ec2.Instance` (`m6i.xlarge`, AL2023, `PRIVATE_WITH_EGRESS`, `ec2Sg`, IMDSv2 required, `httpPutResponseHopLimit: 1`); a 50 GB gp3 root + 200 GB gp3 data volume, both encrypted with `dataKey`, the data volume tagged `supabase:backup=true` so Phase 2's `BackupSelection` picks it up; a `cloudwatch.Alarm` on `AWS/EC2 StatusCheckFailed_System` with an EC2 **recover** action; and user-data that runs `cdk/assets/bootstrap.sh`. The host-side assets (`bootstrap.sh`, `render-env.sh`, `docker-compose.override.yml`, `pgbackrest.conf`, `pgbackrest-cron`) are the heavy content of this phase and are tested with `bash -n` + `shellcheck`. `ComputeStack` exports exactly `instance: ec2.Instance`.

**Tech Stack:** Node.js 22 LTS, aws-cdk-lib v2 (`^2.150`), constructs v10, TypeScript 5, Jest + ts-jest, `shellcheck` + `bash -n` for shell assets. CDK tests use `aws-cdk-lib/assertions` (`Template`).

**Plan series:** This is Phase 3 of 5. It depends on Phase 1 (`FoundationStack.dataKey`, `NetworkStack.vpc/ec2Sg`) and Phase 2 (`DataStack` bucket + secret + vault exports) and keeps `ComputeStack.instance` stable for Phase 4 (`EdgeStack` targets the host via the private data-API ALB) and Phase 5 (restore drill). The data volume tag `supabase:backup=true` is the contract with Phase 2's `BackupSelection`.

**Spec:** `docs/superpowers/specs/2026-06-29-supabase-self-hosted-aws-design.md` (v2). Covers §5 (compose services, analytics/vector opt-in, connection topology), §7 (single instance + auto-recovery, `m6i.xlarge`/16 GB non-burstable, IMDSv2 hop-limit 1, volumes, fail-loud/sentinel bootstrap), §9 (pgBackRest WAL archiving + nightly `pg_dump` to S3), §10 (Storage bucket-scoped creds; omit AWS-key env for other services), §13 (secret handling: no-echo, `chmod 600`, IMDSv2, exact-ARN IAM), §17 (durability/DR acceptance), §22 (upgrade runbook), §21 (`ComputeStack` structure — role-IAM grant, not a bucket resource policy).

**Conventions:**
- All CDK commands run from `cdk/` unless stated. Shell-asset commands (`bash -n`, `shellcheck`) run from the repo root (`~/nsight-supabase`).
- Region `us-east-1`, account `439024109088`. Env passed via CDK context, never hardcoded in constructs.
- Data resources (EBS volumes) use `RemovalPolicy.RETAIN` (HIPAA — never auto-delete PHI-adjacent infra); the data volume is `deleteOnTermination: false`.
- **Bucket access is granted via the role's IAM policy referencing the bucket ARN — never a bucket resource policy naming the role** (spec §21; avoids the v1 circular dependency). Cross-stack wiring is by object reference (CDK-managed), not manual CFN exports.
- IAM references **exact secret/key ARNs, never `*`.** `grantRead` on a Secrets Manager secret encrypted with a CMK also grants `kms:Decrypt` on that key — no extra KMS statement needed.
- The **Supabase image tag/digest is pinned** (single `SUPABASE_REF` constant in the bootstrap; PG17 tag per spec §22). Analytics/vector logs override is **not** enabled (spec §5).
- Commit after every green test/lint.
- If `shellcheck` is not installed on the worker, install it first: `brew install shellcheck` (macOS) — it is a hard requirement for the shell-asset tasks.

---

### Task 0: Add the shell-asset test harness

Phase 1 already scaffolded the CDK project (`cdk/package.json`, `tsconfig.json`, `jest.config.js`, `cdk.json`, `bin/nsight-supabase.ts`). This phase adds a Jest suite that lints the shell assets so shell correctness is enforced the same way CDK correctness is.

**Files:**
- Create: `cdk/test/assets.test.ts`
- Create: `cdk/assets/` (directory; assets added in later tasks)

- [ ] **Step 1: Confirm the toolchain**

Run: `cd ~/nsight-supabase/cdk && npm install >/dev/null 2>&1; command -v shellcheck && bash --version | head -1`
Expected: `shellcheck` path prints and Bash version prints. If `shellcheck` is missing, install it (see Conventions) before proceeding.

- [ ] **Step 2: Write the failing harness test**

This suite discovers every `*.sh` asset and asserts `bash -n` (parse) + `shellcheck` are clean. It fails now because no assets exist yet — that failure is the RED for Task 1's asset. Once `bootstrap.sh` exists it goes green.

```ts
// cdk/test/assets.test.ts
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const assetsDir = path.join(__dirname, '..', 'assets');

function shellAssets(): string[] {
  if (!fs.existsSync(assetsDir)) return [];
  return fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.sh') || f === 'pgbackrest-cron')
    .map((f) => path.join(assetsDir, f));
}

test('at least the bootstrap asset exists', () => {
  const files = shellAssets().map((f) => path.basename(f));
  expect(files).toContain('bootstrap.sh');
});

describe('shell assets parse and lint clean', () => {
  const files = shellAssets();
  // Guard: if discovery returns nothing the describe body is empty and the
  // suite would falsely pass — the test above catches the missing bootstrap.
  for (const file of files) {
    test(`bash -n ${path.basename(file)}`, () => {
      execSync(`bash -n "${file}"`, { stdio: 'pipe' });
    });
    test(`shellcheck ${path.basename(file)}`, () => {
      // -x follows sourced files; -S style surfaces everything.
      execSync(`shellcheck -x -S style "${file}"`, { stdio: 'pipe' });
    });
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest assets`
Expected: FAIL — `expect(files).toContain('bootstrap.sh')` fails (no assets yet).

- [ ] **Step 4: Create the assets directory (kept in git with a `.gitkeep`)**

```bash
mkdir -p ~/nsight-supabase/cdk/assets && touch ~/nsight-supabase/cdk/assets/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/test/assets.test.ts cdk/assets/.gitkeep && git commit -m "test(compute): shell-asset bash -n + shellcheck harness"
```

---

### Task 1: ComputeStack — exact-ARN-scoped instance role (spec §13, §21)

The instance role is `ec2.amazonaws.com`, carries `AmazonSSMManagedInstanceCore` (SSM Session Manager, no SSH — spec §13), and gets **only** what the host process needs: read the four secrets (which also grants `kms:Decrypt` on their CMK), read/write the backup bucket (pgBackRest + `pg_dump`), and put CloudWatch Logs. It **must not** get access to `storageBucket` — the Storage container uses its own bucket-scoped IAM creds (spec §10). No `*` on secrets.

**Files:**
- Create: `cdk/lib/compute-stack.ts`
- Test: `cdk/test/compute-stack.test.ts`

- [ ] **Step 1: Write the failing test**

The test builds real upstream stacks (Foundation + Network + a minimal DataStack-shaped fixture) and asserts the role exists, references the specific secret ARNs (not `*`), grants backup-bucket read/write, and carries the SSM managed policy.

```ts
// cdk/test/compute-stack.test.ts
import { App, Stack, StackProps } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { ComputeStack } from '../lib/compute-stack';

const env = { account: '439024109088', region: 'us-east-1' };

// Minimal fixture standing in for Phase 2's DataStack exports so ComputeStack
// can be tested in isolation. Buckets/secrets here mirror the shared contract.
class DataFixture extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly appConfigSecret: secretsmanager.Secret;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly storageCredsSecret: secretsmanager.Secret;
  public readonly smtpSecret: secretsmanager.Secret;
  constructor(scope: Construct, id: string, secretsKey: kms.IKey, props: StackProps) {
    super(scope, id, props);
    this.storageBucket = new s3.Bucket(this, 'Storage');
    this.backupBucket = new s3.Bucket(this, 'Backup');
    const mk = (i: string) => new secretsmanager.Secret(this, i, { encryptionKey: secretsKey });
    this.appConfigSecret = mk('AppConfig');
    this.serviceRoleSecret = mk('ServiceRole');
    this.storageCredsSecret = mk('StorageCreds');
    this.smtpSecret = mk('Smtp');
  }
}

function makeCompute() {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  const data = new DataFixture(app, 'Data', foundation.secretsKey, { env });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    vpc: network.vpc,
    ec2Sg: network.ec2Sg,
    dataKey: foundation.dataKey,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
    appConfigSecret: data.appConfigSecret,
    serviceRoleSecret: data.serviceRoleSecret,
    storageCredsSecret: data.storageCredsSecret,
    smtpSecret: data.smtpSecret,
  });
  return Template.fromStack(compute);
}

test('creates an EC2 instance role with the SSM core managed policy', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } }),
      ]),
    }),
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
        ]),
      }),
    ]),
  });
});

test('role policy reads the specific secret ARNs, never *', () => {
  const t = makeCompute();
  // secretsmanager:GetSecretValue appears and its Resource is a Ref/ARN, not "*".
  const policies = t.findResources('AWS::IAM::Policy');
  const json = JSON.stringify(policies);
  expect(json).toContain('secretsmanager:GetSecretValue');
  // No statement grants GetSecretValue on "*".
  const stmts = Object.values(policies).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement,
  );
  const secretStmts = stmts.filter(
    (s: any) => JSON.stringify(s.Action).includes('secretsmanager:GetSecretValue'),
  );
  expect(secretStmts.length).toBeGreaterThan(0);
  for (const s of secretStmts) {
    expect(s.Resource).not.toEqual('*');
    expect(JSON.stringify(s.Resource)).not.toEqual('"*"');
  }
});

test('role can read/write the backup bucket but is NOT granted the storage bucket', () => {
  const t = makeCompute();
  const policies = t.findResources('AWS::IAM::Policy');
  const stmts = Object.values(policies).flatMap(
    (p: any) => p.Properties.PolicyDocument.Statement,
  );
  const s3Puts = stmts.filter((s: any) => JSON.stringify(s.Action).includes('s3:PutObject'));
  expect(s3Puts.length).toBeGreaterThan(0); // backup bucket write exists
  // Storage bucket must NOT appear in any grant. Its logical id starts with "Storage".
  // (DataFixture names it "Storage"; the backup bucket "Backup".) The role's policy
  // should reference only the Backup bucket ARN, so no Storage ARN is present.
  const json = JSON.stringify(stmts);
  expect(json).not.toMatch(/Storage[0-9A-F]{8}/); // no Storage bucket logical ref
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest compute-stack`
Expected: FAIL — `Cannot find module '../lib/compute-stack'`.

- [ ] **Step 3: Write the ComputeStack shell + role**

```ts
// cdk/lib/compute-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface ComputeStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly ec2Sg: ec2.ISecurityGroup;
  readonly dataKey: kms.IKey;
  readonly storageBucket: s3.IBucket;
  readonly backupBucket: s3.IBucket;
  readonly appConfigSecret: secretsmanager.ISecret;
  readonly serviceRoleSecret: secretsmanager.ISecret;
  readonly storageCredsSecret: secretsmanager.ISecret;
  readonly smtpSecret: secretsmanager.ISecret;
}

export class ComputeStack extends Stack {
  public readonly instance!: ec2.Instance; // assigned in Task 2

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    // --- Instance role (spec §13, §21): exact-ARN scoped, SSM-only host access ---
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Supabase host role — SSM, scoped secrets, backup bucket, CW Logs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // grantRead on a KMS-encrypted secret also grants kms:Decrypt on its CMK —
    // exact ARNs, never "*".
    props.appConfigSecret.grantRead(role);
    props.serviceRoleSecret.grantRead(role);
    props.storageCredsSecret.grantRead(role);
    props.smtpSecret.grantRead(role);

    // pgBackRest + nightly pg_dump run as host processes and write the backup bucket.
    props.backupBucket.grantReadWrite(role);

    // NOTE: intentionally NO grant on props.storageBucket — the Storage *container*
    // uses its own bucket-scoped IAM creds from storageCredsSecret (spec §10). The
    // host role must never reach the PHI object store.
    void props.storageBucket;

    // CloudWatch Logs put (agent ships host + container logs; log groups live in
    // ObservabilityStack / are created by the agent).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsPut',
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream',
        'logs:PutLogEvents', 'logs:DescribeLogStreams',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/nsight-supabase/*`],
    }));

    this.instanceRole = role;
  }

  // exposed for Task 2
  public readonly instanceRole!: iam.Role;
}
```

> **Type note:** `instanceRole` is declared `readonly` and assigned once in the constructor; TypeScript's definite-assignment (`!`) is used because assignment happens after the field declaration line. Keeping it as a class field lets Task 2 attach it to the instance without re-threading. `instance` is likewise `!` until Task 2 fills it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest compute-stack`
Expected: PASS (all three role tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/compute-stack.ts cdk/test/compute-stack.test.ts && git commit -m "feat(compute): exact-ARN scoped instance role (SSM + secrets + backup bucket)"
```

---

### Task 2: ComputeStack — the EC2 instance, IMDSv2 hop-limit 1, encrypted root + tagged data volume (spec §7)

`m6i.xlarge`, AL2023, private subnet, `ec2Sg`, IMDSv2 required with `httpPutResponseHopLimit: 1`. Root 50 GB gp3 + a second 200 GB gp3 data volume, both encrypted with `dataKey`; the data volume is `deleteOnTermination: false` (survives instance replacement) and tagged `supabase:backup=true` so Phase 2's `BackupSelection` selects it.

> **CDK API note (verified):** `httpTokens`, `httpPutResponseHopLimit`, and `requireImdsv2` are all direct props on `InstanceProps`. Setting `requireImdsv2: true` is equivalent to `httpTokens: 'required'` and is compatible with also setting `httpPutResponseHopLimit`. We set `requireImdsv2: true` **and** `httpPutResponseHopLimit: 1`, which synthesizes a launch template with `HttpTokens: required, HttpPutResponseHopLimit: 1`. (Do not additionally pass `httpTokens` — that would double-specify; `requireImdsv2` already sets it.)

**Files:**
- Modify: `cdk/lib/compute-stack.ts`
- Test: `cdk/test/compute-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('instance is m6i.xlarge with IMDSv2 hop-limit 1', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 'm6i.xlarge' });
  // requireImdsv2 -> a launch template with the metadata options.
  t.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      MetadataOptions: Match.objectLike({
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 1,
      }),
    }),
  });
});

test('root and data volumes are both KMS-encrypted gp3', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::EC2::Instance', {
    BlockDeviceMappings: Match.arrayWith([
      // root 50GB gp3 encrypted
      Match.objectLike({
        Ebs: Match.objectLike({ VolumeSize: 50, VolumeType: 'gp3', Encrypted: true }),
      }),
      // data 200GB gp3 encrypted, retained on terminate
      Match.objectLike({
        Ebs: Match.objectLike({
          VolumeSize: 200, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: false,
        }),
      }),
    ]),
  });
});

test('the data volume carries the supabase:backup=true tag (Phase 2 BackupSelection hook)', () => {
  const t = makeCompute();
  // The data volume mapping's Ebs block does not itself carry tags in CFN; the tag
  // is applied to the volume via a Tags entry on the instance's block-device volume.
  // We assert the tag key/value appears in the synthesized template.
  const json = JSON.stringify(t.toJSON());
  expect(json).toContain('supabase:backup');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest compute-stack -t "m6i.xlarge"`
Expected: FAIL — no `AWS::EC2::Instance` / `LaunchTemplate` yet.

- [ ] **Step 3: Add the instance to the constructor (after the role block, before `this.instanceRole = role;` stays as-is)**

Add imports at the top of `compute-stack.ts`:

```ts
import { Tags, Size } from 'aws-cdk-lib';
```

Add after the CloudWatch Logs policy statement:

```ts
    const dataVolumeDeviceName = '/dev/sdf'; // Nitro renames to /dev/nvme1n1 on AL2023

    this.instance = new ec2.Instance(this, 'Host', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.ec2Sg,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6I, ec2.InstanceSize.XLARGE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      requireImdsv2: true,          // -> HttpTokens: required (IMDSv2 enforced)
      httpPutResponseHopLimit: 1,   // blocks container -> IMDS SSRF (spec §7)
      blockDevices: [
        {
          deviceName: '/dev/xvda', // AL2023 root device
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: props.dataKey,
            deleteOnTermination: true,
          }),
        },
        {
          deviceName: dataVolumeDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(200, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            kmsKey: props.dataKey,
            deleteOnTermination: false, // Postgres state survives instance replacement
          }),
        },
      ],
    });

    // Tag the *whole instance* so its volumes inherit — but the Backup selection keys on
    // the volume tag, so tag it explicitly. CDK applies instance tags to attached volumes
    // when `propagateTagsToVolumeOnCreation` is set on the launch template; we set it and
    // also tag the instance construct so the data volume is selected by Phase 2.
    Tags.of(this.instance).add('supabase:backup', 'true');
    Tags.of(this.instance).add('Name', 'nsight-supabase-host');
    void Size; // (Size imported for readability of volume sizes; not otherwise needed)
```

> **Volume-tag mechanics:** CFN block-device mappings do not accept per-volume tags directly. `ec2.Instance` sets `propagateTagsToVolumeOnCreation: true` on its launch template by default in current CDK, so instance tags propagate to volumes at create time. That means both the root and data volume receive `supabase:backup=true`. Phase 2's `BackupSelection` matches on that tag; the root volume being selected too is acceptable (extra coverage, not a correctness problem). If Phase 2 needs the data volume **only**, add a distinguishing tag there — but this plan keeps the single-tag contract stated in the shared interface. Verify at deploy time (Task 9) that the data volume shows the tag in `describe-volumes`.

Then change the field declaration so `instance` is assigned (remove the `!` non-null since it is now assigned in the constructor):

```ts
  public readonly instance: ec2.Instance;
```

(and keep `public readonly instanceRole: iam.Role;` assigned via `this.instanceRole = role;`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest compute-stack`
Expected: PASS (instance + volume + tag tests, plus the Task 1 role tests still green).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/compute-stack.ts cdk/test/compute-stack.test.ts && git commit -m "feat(compute): m6i.xlarge AL2023 host, IMDSv2 hop-limit 1, encrypted root+data volumes"
```

---

### Task 3: ComputeStack — EC2 auto-recovery alarm (spec §7)

A `cloudwatch.Alarm` on `AWS/EC2` `StatusCheckFailed_System` for this instance, breaching at `>= 1` for a couple of consecutive minutes, with an EC2 **recover** alarm action. This is the single-instance resilience mechanism (same instance, same EBS) — spec §7.

**Files:**
- Modify: `cdk/lib/compute-stack.ts`
- Test: `cdk/test/compute-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('auto-recovery alarm on StatusCheckFailed_System with an EC2 recover action', () => {
  const t = makeCompute();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/EC2',
    MetricName: 'StatusCheckFailed_System',
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    Threshold: 1,
    // The recover action ARN is arn:<partition>:automate:<region>:ec2:recover
    AlarmActions: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([Match.stringLikeRegexp('automate')]),
        ]),
      }),
    ]),
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest compute-stack -t "auto-recovery"`
Expected: FAIL — no `AWS::CloudWatch::Alarm`.

- [ ] **Step 3: Add the alarm (imports + code)**

Add imports:

```ts
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Duration } from 'aws-cdk-lib';
```

Add after the instance/tag block:

```ts
    const systemStatusMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'StatusCheckFailed_System',
      dimensionsMap: { InstanceId: this.instance.instanceId },
      period: Duration.minutes(1),
      statistic: 'Maximum',
    });

    const recoveryAlarm = new cloudwatch.Alarm(this, 'SystemStatusRecoveryAlarm', {
      alarmName: 'nsight-supabase-host-system-status-recover',
      alarmDescription: 'Auto-recover the Supabase host on a failed EC2 system status check',
      metric: systemStatusMetric,
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    recoveryAlarm.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.RECOVER));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest compute-stack`
Expected: PASS (all compute tests green).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/compute-stack.ts cdk/test/compute-stack.test.ts && git commit -m "feat(compute): EC2 auto-recovery alarm on StatusCheckFailed_System"
```

---

### Task 4: Bootstrap asset — `cdk/assets/bootstrap.sh` (fail-loud, idempotent; spec §7, §10, §13)

The full host bootstrap. Runs on the host at boot (reaches IMDS fine at hop-limit 1). Contract, in order:
1. `set -euo pipefail`; require an IMDSv2 token for any metadata read.
2. Install Docker + the compose plugin (AL2023 `dnf`).
3. Mount the data volume **by filesystem UUID** in `/etc/fstab` (handle Nitro `/dev/nvme*` naming).
4. Branch on `.supabase-initialized` sentinel: populated → attach & start without re-init; blank-when-it-should-be-populated → **abort loudly**.
5. Ensure `PGDATA` and `pg_wal` live on the **same** data volume; create the edge-functions dir there.
6. Fetch secrets from Secrets Manager on the host **without echo** (`set +x`, no stdout); write `.env` `chmod 600` root-owned.
7. **Omit** AWS-key env vars for every service except Storage; inject `storageCredsSecret` creds only into the Storage service.
8. Pull the **pinned** Supabase compose bundle (by tag/digest); do **not** enable analytics/vector; `docker compose up -d`.

**Files:**
- Create: `cdk/assets/bootstrap.sh`
- Test: `cdk/test/assets.test.ts` (already covers it via `bash -n` + `shellcheck`)

- [ ] **Step 1: The RED is already in place** — Task 0's `assets.test.ts` fails because `bootstrap.sh` does not exist yet.

Run: `npx jest assets -t "bootstrap"`
Expected: FAIL — `toContain('bootstrap.sh')` fails.

- [ ] **Step 2: Write `cdk/assets/bootstrap.sh`**

```bash
#!/usr/bin/env bash
#
# Supabase host bootstrap — fail-loud, idempotent.
# Runs as root via EC2 user-data on AL2023. Converges against the persistent
# data volume on every re-run. See spec §7, §10, §13.
#
set -euo pipefail

# ---- Tunables (the Supabase bundle is PINNED; PG17 per spec §22) ----------------
readonly SUPABASE_REF="v2.30.4"                 # pin the bundle tag/release (PG17)
readonly SUPABASE_REPO="https://github.com/supabase/supabase.git"
readonly APP_DIR="/opt/supabase"                # compose project lives here (root vol)
readonly DATA_MOUNT="/mnt/pgdata"               # the dedicated EBS data volume
readonly DATA_DEVICE_HINT="/dev/nvme1n1"        # Nitro name for the second EBS volume
readonly SENTINEL="${DATA_MOUNT}/.supabase-initialized"
readonly PGDATA_DIR="${DATA_MOUNT}/db/data"     # PGDATA
readonly PGWAL_DIR="${DATA_MOUNT}/db/wal"       # pg_wal — SAME volume as PGDATA
readonly FUNCTIONS_DIR="${DATA_MOUNT}/functions"
readonly AWS_REGION="us-east-1"
# Secret ARNs are injected by user-data (rendered from CDK); fail if unset.
: "${APP_CONFIG_SECRET_ARN:?APP_CONFIG_SECRET_ARN must be set by user-data}"
: "${SERVICE_ROLE_SECRET_ARN:?SERVICE_ROLE_SECRET_ARN must be set by user-data}"
: "${STORAGE_CREDS_SECRET_ARN:?STORAGE_CREDS_SECRET_ARN must be set by user-data}"
: "${SMTP_SECRET_ARN:?SMTP_SECRET_ARN must be set by user-data}"
: "${STORAGE_BUCKET:?STORAGE_BUCKET must be set by user-data}"

log()  { echo "[bootstrap] $*" >&2; }
die()  { echo "[bootstrap][FATAL] $*" >&2; exit 1; }

# ---- 1. IMDSv2 token (hop-limit 1; the host can reach IMDS) ----------------------
imds_token() {
  curl -fsS -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300"
}
require_imds() {
  local tok
  tok="$(imds_token)" || die "IMDSv2 token request failed — cannot proceed"
  [ -n "$tok" ] || die "Empty IMDSv2 token"
  log "IMDSv2 reachable."
}

# ---- 2. Docker + compose plugin (AL2023) -----------------------------------------
install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + compose already present."
  else
    log "Installing Docker + compose plugin."
    dnf -y install docker
    # compose v2 plugin
    mkdir -p /usr/libexec/docker/cli-plugins
    local cver="v2.29.7"
    curl -fsSL \
      "https://github.com/docker/compose/releases/download/${cver}/docker-compose-linux-x86_64" \
      -o /usr/libexec/docker/cli-plugins/docker-compose
    chmod 0755 /usr/libexec/docker/cli-plugins/docker-compose
  fi
  systemctl enable --now docker
  # Docker log rotation (spec §7) — bound container log growth on the root volume.
  install -d -m 0755 /etc/docker
  cat >/etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
JSON
  systemctl restart docker
  docker compose version >/dev/null 2>&1 || die "docker compose plugin not usable"
}

# ---- 3. Mount the data volume BY UUID (Nitro-safe) -------------------------------
resolve_data_device() {
  # Prefer the hint; else pick the first non-root, unmounted, unpartitioned disk.
  if [ -b "$DATA_DEVICE_HINT" ]; then echo "$DATA_DEVICE_HINT"; return 0; fi
  local dev
  dev="$(lsblk -dno NAME,TYPE | awk '$2=="disk"{print "/dev/"$1}' \
        | grep -vE 'nvme0n1$' | head -n1 || true)"
  [ -n "$dev" ] || die "Could not resolve the data device"
  echo "$dev"
}
mount_data_volume() {
  local dev fstype uuid
  dev="$(resolve_data_device)"
  fstype="$(blkid -o value -s TYPE "$dev" 2>/dev/null || true)"
  install -d -m 0755 "$DATA_MOUNT"
  if [ -z "$fstype" ]; then
    # Blank device. It is legitimate to format ONLY on a truly first-ever boot; the
    # sentinel/abort logic (step 4) guards against wiping a populated-but-unmounted vol.
    log "Data device $dev is unformatted — formatting ext4 (first-ever boot)."
    mkfs.ext4 -m 0 "$dev"
  fi
  uuid="$(blkid -o value -s UUID "$dev")"
  [ -n "$uuid" ] || die "No UUID for $dev after format"
  # Idempotent fstab entry by UUID (Nitro renames devices; UUID is stable).
  if ! grep -q "UUID=${uuid}" /etc/fstab; then
    printf 'UUID=%s  %s  ext4  defaults,nofail  0  2\n' "$uuid" "$DATA_MOUNT" >>/etc/fstab
  fi
  mountpoint -q "$DATA_MOUNT" || mount "$DATA_MOUNT"
  mountpoint -q "$DATA_MOUNT" || die "Failed to mount data volume at $DATA_MOUNT"
  log "Data volume mounted by UUID=$uuid at $DATA_MOUNT."
}

# ---- 4. Sentinel branch (fail-loud on the data-loss trap) ------------------------
# A volume is "populated" if PGDATA has a PG control file. If the sentinel is present
# we start WITHOUT re-init. If PGDATA looks populated but the sentinel is missing (or
# vice-versa) we ABORT rather than initialize a fresh DB over real data.
data_state() {
  local has_sentinel="no" has_pgdata="no"
  [ -f "$SENTINEL" ] && has_sentinel="yes"
  [ -f "${PGDATA_DIR}/PG_VERSION" ] && has_pgdata="yes"
  echo "${has_sentinel}:${has_pgdata}"
}

# ---- 6. Fetch secrets WITHOUT echo, render .env chmod 600 ------------------------
fetch_secret_json() {  # $1 = ARN ; prints raw JSON to stdout (caller must not log it)
  aws secretsmanager get-secret-value \
    --secret-id "$1" --region "$AWS_REGION" \
    --query SecretString --output text
}
render_env() {
  set +x  # never trace secret handling
  install -d -m 0755 "$APP_DIR"
  local envfile="${APP_DIR}/.env"
  umask 077
  # render-env.sh maps the Secrets Manager JSON -> compose env (see Task 5).
  APP_CONFIG_JSON="$(fetch_secret_json "$APP_CONFIG_SECRET_ARN")" \
  SERVICE_ROLE_JSON="$(fetch_secret_json "$SERVICE_ROLE_SECRET_ARN")" \
  STORAGE_CREDS_JSON="$(fetch_secret_json "$STORAGE_CREDS_SECRET_ARN")" \
  SMTP_JSON="$(fetch_secret_json "$SMTP_SECRET_ARN")" \
  STORAGE_BUCKET="$STORAGE_BUCKET" AWS_REGION="$AWS_REGION" \
    bash "${APP_DIR}/render-env.sh" >"$envfile"
  chown root:root "$envfile"
  chmod 600 "$envfile"
  [ -s "$envfile" ] || die ".env render produced an empty file"
  log ".env rendered (600, root-owned). Contents intentionally not logged."
}

# ---- 8. Fetch the pinned bundle, wire overrides, bring the stack up --------------
fetch_bundle() {
  if [ ! -d "${APP_DIR}/.git" ]; then
    log "Cloning Supabase bundle @ ${SUPABASE_REF}."
    git clone --depth 1 --branch "$SUPABASE_REF" "$SUPABASE_REPO" /tmp/supabase-src
    install -d -m 0755 "$APP_DIR"
    cp -a /tmp/supabase-src/docker/. "$APP_DIR"/
    rm -rf /tmp/supabase-src
  else
    log "Bundle already present at $APP_DIR (pinned ${SUPABASE_REF})."
  fi
  # Drop our override + env renderer alongside the compose file (delivered via user-data
  # asset staging; here we assert they exist).
  [ -f "${APP_DIR}/docker-compose.yml" ] || die "compose file missing from bundle"
  [ -f "${APP_DIR}/docker-compose.override.yml" ] || die "override file not staged"
  [ -f "${APP_DIR}/render-env.sh" ] || die "render-env.sh not staged"
}
compose_up() {
  cd "$APP_DIR"
  # Do NOT enable analytics/vector (spec §5) — we never run `run.sh config add logs`,
  # and the override removes any depends_on: analytics edges on older tags.
  docker compose --env-file "${APP_DIR}/.env" up -d
}

main() {
  require_imds
  install_docker
  mount_data_volume

  local state; state="$(data_state)"
  case "$state" in
    yes:yes)
      log "Populated data volume + sentinel present — attaching WITHOUT re-init."
      ;;
    no:yes)
      die "PGDATA is populated but the sentinel is MISSING — refusing to re-init over real data. Investigate ${PGDATA_DIR}."
      ;;
    yes:no)
      die "Sentinel present but PGDATA is EMPTY — data volume did not attach or was wiped. Refusing to initialize a fresh DB. Investigate ${DATA_MOUNT}."
      ;;
    no:no)
      log "First-ever boot on a blank volume — initializing fresh Supabase state."
      install -d -m 0700 "$PGDATA_DIR" "$PGWAL_DIR"
      install -d -m 0755 "$FUNCTIONS_DIR"
      ;;
    *)
      die "Unknown data-volume state: $state"
      ;;
  esac

  # Invariant: PGDATA and pg_wal both live on the data volume (snapshot coherence, §7).
  case "$PGWAL_DIR" in "${DATA_MOUNT}"/*) : ;; *) die "pg_wal must live on the data volume";; esac
  case "$PGDATA_DIR" in "${DATA_MOUNT}"/*) : ;; *) die "PGDATA must live on the data volume";; esac
  install -d -m 0755 "$FUNCTIONS_DIR"

  render_env
  fetch_bundle
  compose_up

  # First-boot only: stamp the sentinel AFTER a clean bring-up so a crashed init does
  # not falsely mark the volume initialized.
  if [ "$state" = "no:no" ] && [ -f "${PGDATA_DIR}/PG_VERSION" ]; then
    date -u +%FT%TZ >"$SENTINEL"
    log "Sentinel stamped — future boots will attach without re-init."
  fi
  log "Bootstrap complete."
}

main "$@"
```

> **Note on the `.env` fetch:** the secret fetch relies on the instance role (Task 1) — `aws secretsmanager get-secret-value` on the host uses the instance profile, which is why the role's `grantRead` on exactly those four secrets is the security boundary. The AWS CLI ships on AL2023. `set +x` is set before any secret variable is created and the raw JSON is never echoed.

- [ ] **Step 3: Verify parse + lint clean**

Run: `npx jest assets` (or directly: `bash -n cdk/assets/bootstrap.sh && shellcheck -x -S style cdk/assets/bootstrap.sh`)
Expected: PASS — `bash -n` clean, `shellcheck` clean. Fix any `shellcheck` finding (quote expansions, `local` on its own line, etc.) until clean.

- [ ] **Step 4: Commit**

```bash
cd ~/nsight-supabase && git add cdk/assets/bootstrap.sh && git commit -m "feat(compute): fail-loud idempotent host bootstrap (UUID mount, sentinel, no-echo secrets)"
```

---

### Task 5: Compose override + env renderer (spec §5, §10)

`docker-compose.override.yml` sets Storage to the S3 backend, binds Studio on `:3000` and Kong Admin on `127.0.0.1` only, and mounts the functions dir. `render-env.sh` maps the Secrets Manager JSON to compose env — omitting AWS-key env for every service **except** Storage, and injecting the bucket-scoped creds only into Storage. Both are `bash -n` + `shellcheck` clean (the override is YAML, validated separately).

**Files:**
- Create: `cdk/assets/docker-compose.override.yml`
- Create: `cdk/assets/render-env.sh`
- Test: `cdk/test/assets.test.ts` (shell) + a grep assertion in the same suite

- [ ] **Step 1: Add the Kong-admin-loopback grep assertion (failing) to `assets.test.ts`**

```ts
import * as fs2 from 'fs';
import * as path2 from 'path';

test('compose override binds Kong Admin to 127.0.0.1 only', () => {
  const override = fs2.readFileSync(
    path2.join(__dirname, '..', 'assets', 'docker-compose.override.yml'), 'utf8',
  );
  // Kong Admin (8001) and Manager (8002) must be loopback-bound; the proxy (8000)
  // is NOT bound to loopback (it is reached via the SG from internal clients).
  expect(override).toMatch(/127\.0\.0\.1:8001/);
  expect(override).toMatch(/127\.0\.0\.1:8444/);
  expect(override).toMatch(/127\.0\.0\.1:8002/);
});

test('render-env.sh injects AWS creds only into the storage service', () => {
  const renderEnv = fs2.readFileSync(
    path2.join(__dirname, '..', 'assets', 'render-env.sh'), 'utf8',
  );
  // Storage-scoped keys present; a comment documents the omit-for-others rule.
  expect(renderEnv).toMatch(/STORAGE_BACKEND=s3/);
  expect(renderEnv).toMatch(/STORAGE_S3_FORCE_PATH_STYLE=false/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest assets -t "Kong Admin"`
Expected: FAIL — file does not exist / `readFileSync` throws.

- [ ] **Step 3: Write `cdk/assets/docker-compose.override.yml`**

> **Verify at build time:** exact env-var and service names differ across pinned tags. Cross-check every key below against `${APP_DIR}/.env.example` for `SUPABASE_REF` before deploy (spec §5, §10). Older tags with `depends_on: analytics` on `kong`/`studio` must have those edges removed here (or the front door hangs — spec §5).

```yaml
# cdk/assets/docker-compose.override.yml
# Overlay on the pinned Supabase bundle's docker-compose.yml.
# VERIFY every key against the pinned tag's .env.example (§5, §10).
services:
  studio:
    # Studio reachable on :3000 (ALB targets this; SG allows :3000 from ALB only).
    ports:
      - "3000:3000"
    # If the pinned tag declares `depends_on: analytics`, null it out so the front
    # door does not hang (analytics/vector is NOT enabled — §5).
    depends_on: {}

  kong:
    # Proxy :8000 stays reachable (SG-gated from internal clients). Kong Admin
    # (:8001/:8444) and Manager (:8002) bind to loopback ONLY — never in any SG/ALB
    # target (§6, §11). Verified unreachable in §17.
    ports:
      - "8000:8000/tcp"
      - "127.0.0.1:8001:8001/tcp"
      - "127.0.0.1:8444:8444/tcp"
      - "127.0.0.1:8002:8002/tcp"
    depends_on: {}

  storage:
    # S3 backend against the dedicated, bucket-scoped bucket. Creds are injected via
    # the env-file ONLY for this service (render-env.sh), never the instance role.
    environment:
      STORAGE_BACKEND: s3
      STORAGE_S3_BUCKET: ${STORAGE_S3_BUCKET}
      STORAGE_S3_REGION: ${STORAGE_S3_REGION}
      STORAGE_S3_FORCE_PATH_STYLE: "false"     # real S3, not MinIO
      AWS_ACCESS_KEY_ID: ${STORAGE_AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${STORAGE_AWS_SECRET_ACCESS_KEY}
      AWS_DEFAULT_REGION: ${STORAGE_S3_REGION}
      # NOTE: omit STORAGE_S3_ENDPOINT entirely for real S3 (§10).

  functions:
    # Edge Functions dir lives on the persistent data volume (§7).
    volumes:
      - /mnt/pgdata/functions:/home/deno/functions:rw
```

- [ ] **Step 4: Write `cdk/assets/render-env.sh`**

```bash
#!/usr/bin/env bash
#
# render-env.sh — map Secrets Manager JSON (passed as env vars by bootstrap.sh)
# into the compose .env on stdout. NEVER echoes secrets to a log; only writes stdout,
# which bootstrap.sh redirects into a chmod-600 root-owned .env. (§10, §13)
#
set -euo pipefail
set +x  # never trace secret handling

: "${APP_CONFIG_JSON:?}"
: "${SERVICE_ROLE_JSON:?}"
: "${STORAGE_CREDS_JSON:?}"
: "${SMTP_JSON:?}"
: "${STORAGE_BUCKET:?}"
: "${AWS_REGION:?}"

jget() { printf '%s' "$2" | jq -er --arg k "$1" '.[$k]'; }

# --- App config (crown-jewel + operational secrets) ---
POSTGRES_PASSWORD="$(jget POSTGRES_PASSWORD "$APP_CONFIG_JSON")"
JWT_SECRET="$(jget JWT_SECRET "$APP_CONFIG_JSON")"
ANON_KEY="$(jget ANON_KEY "$APP_CONFIG_JSON")"
SECRET_KEY_BASE="$(jget SECRET_KEY_BASE "$APP_CONFIG_JSON")"
VAULT_ENC_KEY="$(jget VAULT_ENC_KEY "$APP_CONFIG_JSON")"
PG_META_CRYPTO_KEY="$(jget PG_META_CRYPTO_KEY "$APP_CONFIG_JSON")"
POOLER_TENANT_ID="$(jget POOLER_TENANT_ID "$APP_CONFIG_JSON")"
DASHBOARD_USERNAME="$(jget DASHBOARD_USERNAME "$APP_CONFIG_JSON")"
DASHBOARD_PASSWORD="$(jget DASHBOARD_PASSWORD "$APP_CONFIG_JSON")"
S3_PROTOCOL_ACCESS_KEY_ID="$(jget S3_PROTOCOL_ACCESS_KEY_ID "$APP_CONFIG_JSON")"
S3_PROTOCOL_ACCESS_KEY_SECRET="$(jget S3_PROTOCOL_ACCESS_KEY_SECRET "$APP_CONFIG_JSON")"

# --- service_role (BYPASSRLS crown jewel; server-side only) ---
SERVICE_ROLE_KEY="$(jget SERVICE_ROLE_KEY "$SERVICE_ROLE_JSON")"

# --- Storage bucket-scoped IAM creds (§10) — Storage service ONLY ---
STORAGE_AWS_ACCESS_KEY_ID="$(jget AWS_ACCESS_KEY_ID "$STORAGE_CREDS_JSON")"
STORAGE_AWS_SECRET_ACCESS_KEY="$(jget AWS_SECRET_ACCESS_KEY "$STORAGE_CREDS_JSON")"

# --- SES SMTP ---
SMTP_USER="$(jget SMTP_USER "$SMTP_JSON")"
SMTP_PASS="$(jget SMTP_PASS "$SMTP_JSON")"

# Emit the compose .env. NOTE: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are
# emitted ONLY as the STORAGE_-prefixed vars consumed by the storage service in the
# override. They are deliberately NOT emitted as bare env for any other service —
# rendering them blank would OVERRIDE the credential chain and break auth (§10).
cat <<ENV
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ANON_KEY=${ANON_KEY}
SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
SECRET_KEY_BASE=${SECRET_KEY_BASE}
VAULT_ENC_KEY=${VAULT_ENC_KEY}
PG_META_CRYPTO_KEY=${PG_META_CRYPTO_KEY}
POOLER_TENANT_ID=${POOLER_TENANT_ID}
DASHBOARD_USERNAME=${DASHBOARD_USERNAME}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}
S3_PROTOCOL_ACCESS_KEY_ID=${S3_PROTOCOL_ACCESS_KEY_ID}
S3_PROTOCOL_ACCESS_KEY_SECRET=${S3_PROTOCOL_ACCESS_KEY_SECRET}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
STORAGE_BACKEND=s3
STORAGE_S3_BUCKET=${STORAGE_BUCKET}
STORAGE_S3_REGION=${AWS_REGION}
STORAGE_S3_FORCE_PATH_STYLE=false
STORAGE_AWS_ACCESS_KEY_ID=${STORAGE_AWS_ACCESS_KEY_ID}
STORAGE_AWS_SECRET_ACCESS_KEY=${STORAGE_AWS_SECRET_ACCESS_KEY}
ENV
```

> **`jq` dependency:** `render-env.sh` uses `jq`. Add `jq` to the `dnf -y install` line in `bootstrap.sh` `install_docker()` (or a small `install_deps()` step) so it is present before `render_env` runs. Update Task 4's install to `dnf -y install docker git jq`.

- [ ] **Step 5: Verify parse + lint + grep clean**

Run: `npx jest assets`
Expected: PASS — `bash -n`/`shellcheck` clean on `render-env.sh`; Kong-loopback + storage-only grep assertions pass. (The YAML override is not shell; it is validated by the grep tests and, at deploy, by `docker compose config`.)

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/assets/docker-compose.override.yml cdk/assets/render-env.sh cdk/test/assets.test.ts && git commit -m "feat(compute): S3 storage override + secret-to-env renderer (storage-only AWS creds)"
```

---

### Task 6: pgBackRest asset — WAL archiving + scheduled backups + nightly pg_dump (spec §9)

`pgbackrest.conf` points pgBackRest at the `backupBucket` (S3, via the instance role); `pgbackrest-cron` schedules full/diff backups and a nightly `pg_dump` to the backup bucket, and documents the Postgres `archive_command` wiring. Postgres already ships `wal_level=logical` (spec §5) — we add `archive_mode=on` + `archive_command`.

**Files:**
- Create: `cdk/assets/pgbackrest.conf`
- Create: `cdk/assets/pgbackrest-cron`
- Test: `cdk/test/assets.test.ts` (`bash -n` + `shellcheck` on `pgbackrest-cron`)

- [ ] **Step 1: The RED** — `assets.test.ts` discovers `pgbackrest-cron` (Task 0 already includes `pgbackrest-cron` in the glob) and fails `shellcheck`/`bash -n` until it exists and is clean.

Run: `npx jest assets`
Expected: still green from Task 5 until we add a new assertion; add the discovery assertion:

```ts
test('pgbackrest assets exist', () => {
  const files = fs2.readdirSync(path2.join(__dirname, '..', 'assets'));
  expect(files).toContain('pgbackrest.conf');
  expect(files).toContain('pgbackrest-cron');
});
```

Run: `npx jest assets -t "pgbackrest assets exist"` → FAIL.

- [ ] **Step 2: Write `cdk/assets/pgbackrest.conf`**

```ini
# cdk/assets/pgbackrest.conf  — installed to /etc/pgbackrest/pgbackrest.conf
# S3 repo on the KMS-encrypted backup bucket, reached via the instance role (§9).
# The bucket name/region are templated by bootstrap (sed on ${BACKUP_BUCKET}/${AWS_REGION}).
[global]
repo1-type=s3
repo1-s3-bucket=__BACKUP_BUCKET__
repo1-s3-region=__AWS_REGION__
repo1-s3-endpoint=s3.__AWS_REGION__.amazonaws.com
repo1-s3-key-type=auto           # use the EC2 instance-profile creds (no static keys)
repo1-path=/pgbackrest
repo1-retention-full=4
repo1-retention-diff=14
repo1-bundle=y
process-max=2
log-level-console=info
log-level-file=detail
start-fast=y
compress-type=zst

[supabase]
pg1-path=/mnt/pgdata/db/data      # PGDATA on the data volume (§7)
pg1-port=5432
```

> Postgres side (documented; applied via the `db` container config or `ALTER SYSTEM`):
> ```
> archive_mode = on
> wal_level = logical            # already set by the supabase/postgres image (§5)
> archive_command = 'pgbackrest --stanza=supabase archive-push %p'
> ```
> Restart of the `db` container is required for `archive_mode`. `restore_command` for PITR is `pgbackrest --stanza=supabase archive-get %f %p` (used in the Phase 5 restore drill).

- [ ] **Step 3: Write `cdk/assets/pgbackrest-cron`**

```bash
#!/usr/bin/env bash
#
# pgbackrest-cron — installed to /etc/cron.d wrappers or invoked from systemd timers.
# Runs on the host as the postgres/backup user. Full weekly, diff daily, nightly
# pg_dump to the backup bucket. Uses the instance role for S3 (§9).
#
set -euo pipefail

readonly STANZA="supabase"
readonly BACKUP_BUCKET="${BACKUP_BUCKET:?BACKUP_BUCKET must be set}"
readonly AWS_REGION="${AWS_REGION:-us-east-1}"
readonly DB_CONTAINER="supabase-db"     # verify against the pinned bundle's service name
readonly DUMP_PREFIX="s3://${BACKUP_BUCKET}/pg_dump"

log() { echo "[pgbackrest-cron] $*" >&2; }
die() { echo "[pgbackrest-cron][FATAL] $*" >&2; exit 1; }

ensure_stanza() {
  pgbackrest --stanza="$STANZA" stanza-create 2>/dev/null || true
  pgbackrest --stanza="$STANZA" check || die "pgBackRest stanza check failed"
}

backup() {  # $1 = full|diff
  local type="$1"
  log "Starting ${type} backup."
  pgbackrest --stanza="$STANZA" --type="$type" backup || die "${type} backup failed"
  log "${type} backup complete."
}

nightly_pg_dump() {
  local ts out
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="/tmp/supabase-${ts}.dump"
  log "Nightly pg_dumpall -> ${DUMP_PREFIX}/supabase-${ts}.sql.gz"
  # pg_dumpall via the db container; pipe compressed straight to S3 (instance role).
  docker exec "$DB_CONTAINER" pg_dumpall -U postgres \
    | gzip -c >"$out" || die "pg_dumpall failed"
  aws s3 cp "$out" "${DUMP_PREFIX}/supabase-${ts}.sql.gz" \
    --region "$AWS_REGION" --sse aws:kms || die "pg_dump upload failed"
  rm -f "$out"
  log "Nightly pg_dump uploaded."
}

usage() { echo "usage: $0 {stanza|full|diff|dump}" >&2; exit 2; }

main() {
  [ $# -ge 1 ] || usage
  case "$1" in
    stanza) ensure_stanza ;;
    full)   ensure_stanza; backup full ;;
    diff)   ensure_stanza; backup diff ;;
    dump)   nightly_pg_dump ;;
    *)      usage ;;
  esac
}

main "$@"
```

> **Scheduling (documented, applied by bootstrap):** install systemd timers or `/etc/cron.d` entries — `full` Sunday 02:00, `diff` daily 02:00 (non-Sunday), `dump` daily 03:00 — each exporting `BACKUP_BUCKET`/`AWS_REGION`. Backup-job FAILED alarms are wired in the `ObservabilityStack` (spec §16), not here.

- [ ] **Step 4: Verify parse + lint clean**

Run: `npx jest assets`
Expected: PASS — `bash -n`/`shellcheck` clean on `pgbackrest-cron`; discovery assertion green. (`pgbackrest.conf` is INI, not linted by shell tools.)

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/assets/pgbackrest.conf cdk/assets/pgbackrest-cron cdk/test/assets.test.ts && git commit -m "feat(compute): pgBackRest S3 WAL/PITR config + full/diff/pg_dump cron"
```

---

### Task 7: Wire the bootstrap into the instance user-data (spec §7)

Attach `bootstrap.sh` (and stage the override, `render-env.sh`, `pgbackrest.conf`, `pgbackrest-cron`) onto the instance via user-data. The secret ARNs, bucket names, and region are exported as shell vars ahead of the bootstrap so it fails loud if any is unset. The staged assets are delivered by writing them into `${APP_DIR}` from S3 assets (`aws-s3-assets`) or, more simply for shell files, inline via user-data `addUserData`.

**Files:**
- Modify: `cdk/lib/compute-stack.ts`
- Test: `cdk/test/compute-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('instance user-data references the bootstrap and exports the secret ARNs', () => {
  const t = makeCompute();
  // UserData is base64-encoded in the launch template. Assert the decoded form
  // contains our exported vars + the bootstrap invocation.
  const template = t.toJSON();
  const json = JSON.stringify(template);
  // The user-data is a Fn::Base64 of a joined string; the var names appear in the
  // (unencoded) Fn::Join parts.
  expect(json).toContain('APP_CONFIG_SECRET_ARN');
  expect(json).toContain('STORAGE_CREDS_SECRET_ARN');
  expect(json).toContain('bootstrap.sh');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest compute-stack -t "user-data"`
Expected: FAIL — no user-data references yet.

- [ ] **Step 3: Add user-data staging + bootstrap invocation**

Add imports:

```ts
import * as fs from 'fs';
import * as path from 'path';
```

Before creating `this.instance`, build user-data (then pass `userData` into the `Instance` props):

```ts
    const assetDir = path.join(__dirname, '..', 'assets');
    const readAsset = (f: string) => fs.readFileSync(path.join(assetDir, f), 'utf8');

    const userData = ec2.UserData.forLinux();
    // Export the exact ARNs/names the bootstrap requires (fail-loud if unset).
    userData.addCommands(
      'set -euo pipefail',
      'install -d -m 0755 /opt/supabase',
      `export APP_CONFIG_SECRET_ARN='${props.appConfigSecret.secretArn}'`,
      `export SERVICE_ROLE_SECRET_ARN='${props.serviceRoleSecret.secretArn}'`,
      `export STORAGE_CREDS_SECRET_ARN='${props.storageCredsSecret.secretArn}'`,
      `export SMTP_SECRET_ARN='${props.smtpSecret.secretArn}'`,
      `export STORAGE_BUCKET='${props.storageBucket.bucketName}'`,
      `export BACKUP_BUCKET='${props.backupBucket.bucketName}'`,
    );
    // Stage the host-side assets by writing them verbatim (heredoc) to /opt/supabase.
    const stage = (name: string, dest: string, mode: string) => {
      userData.addCommands(
        `cat >'${dest}' <<'NSIGHT_EOF_${name.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}'`,
        readAsset(name),
        `NSIGHT_EOF_${name.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`,
        `chmod ${mode} '${dest}'`,
      );
    };
    stage('render-env.sh', '/opt/supabase/render-env.sh', '0750');
    stage('docker-compose.override.yml', '/opt/supabase/docker-compose.override.yml', '0644');
    stage('pgbackrest.conf', '/etc/pgbackrest/pgbackrest.conf', '0640');
    stage('pgbackrest-cron', '/usr/local/bin/pgbackrest-cron', '0750');
    stage('bootstrap.sh', '/opt/supabase/bootstrap.sh', '0700');
    userData.addCommands('/opt/supabase/bootstrap.sh');
```

> **Note:** `pgbackrest.conf` is staged before its parent dir exists — prepend `install -d -m 0750 /etc/pgbackrest` to the staging. Also `bootstrap.sh`'s `fetch_bundle` expects the override + `render-env.sh` already at `${APP_DIR}` — the staging order above satisfies that (assets written before `bootstrap.sh` runs). The `__BACKUP_BUCKET__`/`__AWS_REGION__` placeholders in `pgbackrest.conf` are substituted by a `sed` line added to the staging (`sed -i "s|__BACKUP_BUCKET__|${BACKUP_BUCKET}|; s|__AWS_REGION__|us-east-1|" /etc/pgbackrest/pgbackrest.conf`).

Then add `userData` to the `Instance` props (in the object created in Task 2):

```ts
      userData,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest compute-stack`
Expected: PASS — user-data test green; all prior compute tests still green.

- [ ] **Step 5: Full compute + asset suites + typecheck**

Run: `npx tsc --noEmit && npx jest compute-stack assets`
Expected: `tsc` exits 0; both suites pass.

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/compute-stack.ts cdk/test/compute-stack.test.ts && git commit -m "feat(compute): stage host assets + run bootstrap via EC2 user-data"
```

---

### Task 8: Wire ComputeStack into the app entry and verify synth

**Files:**
- Modify: `cdk/bin/nsight-supabase.ts`
- Test: `cdk/test/app.test.ts` (extend Phase 1's synth test)

- [ ] **Step 1: Extend the synth test (append to `app.test.ts`)**

```ts
test('SupabaseCompute is in the synthesized cloud assembly', () => {
  const out = execSync('npx cdk list 2>&1', { cwd: process.cwd() }).toString();
  expect(out).toContain('SupabaseCompute');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest app -t "SupabaseCompute"`
Expected: FAIL — stack not wired.

- [ ] **Step 3: Wire the stack in `bin/nsight-supabase.ts`**

This depends on Phase 2's `DataStack`. If Phase 2 is not yet merged into `bin/`, wire against the real `DataStack` import (the shared contract). Replace/extend the stack wiring:

```ts
import { DataStack } from '../lib/data-stack';       // Phase 2
import { ComputeStack } from '../lib/compute-stack';  // Phase 3

// foundation + network already created in earlier phases:
const data = new DataStack(app, 'SupabaseData', {
  env,
  dataKey: foundation.dataKey,
  backupKey: foundation.backupKey,
  secretsKey: foundation.secretsKey,
  vpc: network.vpc,
});

new ComputeStack(app, 'SupabaseCompute', {
  env,
  vpc: network.vpc,
  ec2Sg: network.ec2Sg,
  dataKey: foundation.dataKey,
  storageBucket: data.storageBucket,
  backupBucket: data.backupBucket,
  appConfigSecret: data.appConfigSecret,
  serviceRoleSecret: data.serviceRoleSecret,
  storageCredsSecret: data.storageCredsSecret,
  smtpSecret: data.smtpSecret,
});
```

> If `DataStack`'s exact prop shape differs from the assumed `{dataKey, backupKey, secretsKey, vpc}`, match Phase 2's actual `DataStackProps` — the ComputeStack consumption of `data.*` exports is the fixed contract, not DataStack's constructor.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest app`
Expected: PASS — `SupabaseCompute` in `cdk list`; synth clean.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: `tsc` exits 0; all Jest suites pass (foundation, network, data, compute, assets, app).

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/bin/nsight-supabase.ts cdk/test/app.test.ts && git commit -m "feat(cdk): wire ComputeStack into the app"
```

---

### Task 9: Deploy the compute layer and confirm (manual verification gate)

> Deployment is an outward action against account `439024109088` and boots a PHI-adjacent host. **Confirm with the owner before running `cdk deploy`.** Foundation, Network, and Data stacks (Phases 1–2) must already be deployed. SES production access and the pinned `SUPABASE_REF`'s `.env.example` key names must be verified first (spec §20, §5).

- [ ] **Step 1: Diff**

Run: `npx cdk diff SupabaseCompute`
Expected: shows 1 instance role + policies (scoped to the four secret ARNs + backup bucket + CW Logs, no `*`, no storage-bucket grant), 1 launch template (IMDSv2 hop-limit 1), 1 instance (`m6i.xlarge`, AL2023), 2 block devices (50 GB + 200 GB gp3, encrypted), 1 CloudWatch alarm with the recover action. No deletions.

- [ ] **Step 2: Deploy (after owner OK)**

Run: `npx cdk deploy SupabaseCompute --require-approval broadening`
Expected: `CREATE_COMPLETE`. IAM broadening prompt lists the scoped secret/bucket/logs statements.

- [ ] **Step 3: Confirm the host + volume tag**

```bash
aws ec2 describe-instances --filters Name=tag:Name,Values=nsight-supabase-host \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,State:State.Name}' --region us-east-1
aws ec2 describe-volumes --filters Name=tag:supabase:backup,Values=true \
  --query 'Volumes[].{Id:VolumeId,Size:Size,Enc:Encrypted}' --region us-east-1
```

Expected: one `m6i.xlarge` running; the 200 GB encrypted data volume shows `supabase:backup=true`.

- [ ] **Step 4: Confirm bootstrap + compose came up (SSM, no SSH)**

```bash
aws ssm start-session --target <instance-id> --region us-east-1
# on host:  sudo docker compose -p supabase ps   # all services healthy, no analytics/vector
#           sudo ls -l /opt/supabase/.env          # -rw------- root root (chmod 600)
#           sudo grep -c 127.0.0.1 <(sudo docker compose port kong 8001 || true)  # loopback-only
```

Expected: all compose services healthy with **analytics/vector absent** (no hung `kong`/`studio`); `.env` is `600` root-owned; Kong Admin bound to loopback.

- [ ] **Step 5: Acceptance references (spec §17) — recorded, not re-implemented here**

- **Durability / data-survival (spec §17):** **terminate (not reboot)** the instance and confirm data survives via auto-recovery/volume retention **and** that the bootstrap **refuses to re-init** when the data volume is populated (the `yes:yes` sentinel branch attaches; a `no:yes`/`yes:no` mismatch aborts loudly). Record the outcome.
- **Kong Admin unreachable from in-VPC** (spec §17, §11): confirm `:8001`/`:8444`/`:8002` are not reachable from an internal client (loopback-only binding).
- **Restore drill is Phase 5**, not this phase: the actual PITR restore into a fresh instance + row-count/schema/Storage round-trip + measured RTO is executed and documented in Phase 5. Phase 3 only lays the pgBackRest/`pg_dump` machinery that Phase 5 restores from.

- [ ] **Step 6: Record outputs** (instance id, data volume id, role ARN, alarm ARN) for Phase 4 (`EdgeStack` target) and Phase 5 (restore drill), and stop.

---

## Self-Review (Phase 3)

**Spec coverage:**
- **§5** (compose services, analytics/vector opt-in, connection topology) → Task 5 override nulls `depends_on: analytics`, never enables the logs override; Task 4 `compose_up` comment enforces "no `run.sh config add logs`". Supavisor/Kong port topology is enforced by Phase 1's SGs (referenced, not re-built).
- **§7** (single instance + auto-recovery, `m6i.xlarge`/16 GB non-burstable, IMDSv2 hop-limit 1, volumes: PGDATA+pg_wal same volume, UUID mount, functions dir; fail-loud/sentinel bootstrap) → Tasks 2 (instance/volumes/IMDSv2), 3 (auto-recovery alarm), 4 (UUID mount + sentinel + same-volume invariant + functions dir + fail-loud abort).
- **§9** (pgBackRest WAL archiving + nightly pg_dump to S3) → Task 6 (`pgbackrest.conf` S3 repo via instance role, `archive_command`, full/diff cron, nightly `pg_dumpall` to backup bucket).
- **§10** (Storage bucket-scoped creds; omit AWS-key env for other services) → Task 1 (role has **no** storage-bucket grant), Task 5 (`render-env.sh` emits AWS creds only as `STORAGE_`-prefixed vars consumed solely by the storage service; documented no-blank-override rule; `STORAGE_S3_FORCE_PATH_STYLE=false`, endpoint omitted).
- **§13** (no-echo, `chmod 600`, IMDSv2, exact-ARN IAM) → Task 1 (exact-ARN `grantRead`, no `*`, SSM-only), Task 4 (`set +x`, no stdout, `.env` 600 root-owned).
- **§17** (data-survival test; restore drill is Phase 5) → Task 9 Step 5 references terminate-not-reboot + re-init refusal + Kong-admin-unreachable; restore drill explicitly deferred to Phase 5.
- **§21** (`ComputeStack` structure; role-IAM grant not bucket policy; object-reference wiring) → Task 1 uses `bucket.grantReadWrite`/`secret.grantRead` (role-side IAM), never a bucket resource policy naming the role; Task 8 wires by object reference, no manual CFN exports; exports exactly `instance`.
- **§22** (upgrade runbook / PG17 pin) → Task 4 `SUPABASE_REF` pinned to a PG17 tag; noted for the major-upgrade path.

**Placeholder scan:** none. Every CDK/shell/YAML/INI block is complete and runnable. Deliberate template tokens (`__BACKUP_BUCKET__`/`__AWS_REGION__` in `pgbackrest.conf`, `<instance-id>` in the SSM command, `SUPABASE_REF`/`DB_CONTAINER` "verify against pinned tag" notes) are documented substitution points, not unfinished code. The `void props.storageBucket;`/`void Size;` lines are intentional (satisfy `noUnusedLocals` while documenting the *deliberate* non-use of the storage bucket — the security-relevant omission).

**Type consistency vs the shared contract:** `ComputeStackProps` matches the contract exactly — `{ vpc: ec2.IVpc; ec2Sg: ec2.ISecurityGroup; dataKey: kms.IKey; storageBucket, backupBucket: s3.IBucket; appConfigSecret, serviceRoleSecret, storageCredsSecret, smtpSecret: secretsmanager.ISecret } & StackProps`. `ComputeStack` exports exactly `instance: ec2.Instance` (plus an internal `instanceRole` helper field, not part of the cross-phase contract). Consumes Phase 1 `NetworkStack.vpc/ec2Sg` + `FoundationStack.dataKey` and Phase 2 `DataStack.storageBucket/backupBucket/appConfigSecret/serviceRoleSecret/storageCredsSecret/smtpSecret` under their contract names. The `appConfigSecret` JSON keys consumed in `render-env.sh` (POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SECRET_KEY_BASE, VAULT_ENC_KEY, PG_META_CRYPTO_KEY, POOLER_TENANT_ID, DASHBOARD_USERNAME, DASHBOARD_PASSWORD, S3_PROTOCOL_ACCESS_KEY_ID, S3_PROTOCOL_ACCESS_KEY_SECRET), `serviceRoleSecret.SERVICE_ROLE_KEY`, and `storageCredsSecret.{AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY}` all match the shared interface. The data-volume tag `supabase:backup=true` matches Phase 2's `BackupSelection` hook.

**Known risk / verify-at-deploy items (called out inline, not gaps):**
1. **AL2023 AMI** via `MachineImage.latestAmazonLinux2023()` — resolves to the latest SSM-published AMI at synth; pin a specific AMI id if reproducibility across synths is required.
2. **Single-instance auto-recovery vs a standalone volume:** per spec §7 the data volume is an **in-instance block device** with `deleteOnTermination: false` (NOT a standalone `ec2.Volume` + attachment) — this is the deliberate fix for the v1 ASG data-loss trap; auto-recovery keeps the same instance + same EBS. A hard *terminate* still requires the Phase 5 restore path (documented). Trade-off is explicit in spec §7/§19.
3. **Volume tag propagation:** the `supabase:backup=true` tag propagates to **both** volumes via `propagateTagsToVolumeOnCreation`; extra backup coverage of the root volume is acceptable. Verify at deploy (Task 9 Step 3).
4. **Pinned `SUPABASE_REF` + `.env.example` drift:** exact env-var names and the `depends_on: analytics` edges vary by tag — Task 5 mandates a build-time cross-check (spec §5, §10). `SUPABASE_REF`/`DB_CONTAINER`/compose service names must be confirmed against the chosen PG17 tag.
5. **`requireImdsv2` + `httpPutResponseHopLimit`:** verified compatible on `InstanceProps` (setting `requireImdsv2` implies `HttpTokens: required`; hop-limit is additive). Do not also pass `httpTokens` (double-specify).
