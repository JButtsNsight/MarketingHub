# Supabase on AWS — Phase 5: Observability, Alarms & Deploy Gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the single-node safety net — `ObservabilityStack` (SNS on-call topic, the full CloudWatch alarm bundle, backup-failure detection, replication-slot-lag monitoring, and a Budget alarm), plus the HIPAA deploy-gate and audit assets that live as SQL/shell/config files (RLS gate, `pgaudit`, CloudTrail data events, `pg_net` lockdown, log tiering to S3/Glacier) and the two operational runbooks (restore drill, major-PG upgrade) — as a deployable, test-covered increment.

**Architecture:** `ObservabilityStack` (`cdk/lib/observability-stack.ts`) consumes the Phase 3 `ComputeStack.instance`, the Phase 2 `DataStack.backupVault`, and `FoundationStack.logsKey`. It builds a KMS-encrypted `sns.Topic` with an email subscription (on-call), CloudWatch alarms (instance status check, CPU high, root+data `disk_used_percent` ≥80% from the CloudWatch-agent `CWAgent` namespace), an EventBridge rule on AWS Backup `Backup Job State Change`→FAILED → SNS, a scheduled Lambda that publishes a `pg_replication_slots` retained-WAL custom metric + an alarm on it, a `budgets.CfnBudget`, a `cloudtrail.Trail` with S3 data-event selectors on the PHI storage+backup buckets, and short-retention operational log groups that export to the 7-yr S3/Glacier archive. The SQL/shell gate assets are validated by grep + `bash -n`/`shellcheck` (SQL is lint-by-inspection). Tests use `aws-cdk-lib/assertions` (`Template`) for the stack, the CDK-native TDD pattern.

**Tech Stack:** Node.js 22 LTS, aws-cdk-lib v2, constructs v10, TypeScript 5, Jest + ts-jest; `psql` + `bash`/`shellcheck` for the gate assets; Python 3.12 inline Lambda (`psycopg`-free — uses the `postgres` client via the AWS-provided runtime layer is avoided; see Task 5 for the connection approach).

**Plan series:** This is Phase 5 of 5 (final). It depends on construct properties exported by earlier phases and must NOT rename them:
- `FoundationStack.logsKey: kms.Key` (Phase 1).
- `DataStack.backupVault: backup.BackupVault` plus the storage + backup S3 buckets and secrets (Phase 2).
- `ComputeStack.instance: ec2.Instance` (Phase 3), and `NetworkStack.vpc` / `NetworkStack.internalClientSg` (Phase 1) for the replication-slot Lambda's VPC placement.

**Spec:** `docs/superpowers/specs/2026-06-29-supabase-self-hosted-aws-design.md` (v2). Covers §9 (RTO/RPO, restore drills), §12 (RLS deploy gate; `pg_net` lockdown; Realtime authorization), §15 (`pgaudit`, CloudTrail data events, log tiering, no-PHI-in-logs), §16 (alarm bundle + SNS on-call + Budget), §17 (acceptance incl. restore drill), §22 (upgrade runbook), §21 (`ObservabilityStack`).

**Conventions:**
- All CDK commands run from `cdk/` unless stated. Runbooks/SQL/shell paths are repo-relative from the repo root (`~/nsight-supabase`).
- Region `us-east-1`, account `439024109088`. Env + `oncallEmail` + `monthlyBudgetUsd` come from CDK context, never hardcoded in constructs.
- Log groups, the SNS topic, and the CloudTrail bucket use `RemovalPolicy.RETAIN` (HIPAA — never auto-delete audit-adjacent infra).
- Commit after every green test.

**Shared interface contract (do not rename):**

```ts
// cdk/lib/observability-stack.ts
export interface ObservabilityStackProps extends StackProps {
  readonly instance: ec2.Instance;
  readonly backupVault: backup.BackupVault;
  readonly logsKey: kms.IKey;
  // extended in Task 5 for the replication-slot Lambda's VPC placement:
  readonly vpc: ec2.IVpc;
  readonly internalClientSg: ec2.ISecurityGroup;
  // PHI buckets for CloudTrail data events (Task 7):
  readonly storageBucket: s3.IBucket;
  readonly backupBucket: s3.IBucket;
}
export class ObservabilityStack extends Stack {
  public readonly topic: sns.Topic;
}
```

Context read once at the top of every task's test via:

```ts
const env = { account: '439024109088', region: 'us-east-1' };
const context = { oncallEmail: 'oncall@nsightcare.com', monthlyBudgetUsd: 550 };
```

---

### Task 0: ObservabilityStack skeleton + test harness

Establish the stack file, the props contract, and a reusable `makeStack()` test harness that stands up the upstream stacks (Foundation/Network/Data/Compute) and wires their exports into `ObservabilityStack`. Every later task appends assertions against this harness.

**Files:**
- Create: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (the harness + a smoke assertion)**

```ts
// cdk/test/observability-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ComputeStack } from '../lib/compute-stack';
import { ObservabilityStack } from '../lib/observability-stack';

const env = { account: '439024109088', region: 'us-east-1' };
const context = { oncallEmail: 'oncall@nsightcare.com', monthlyBudgetUsd: 550 };

export function makeStack(): { t: Template; stack: ObservabilityStack } {
  const app = new App({ context });
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const network = new NetworkStack(app, 'Network', { env, logsKey: foundation.logsKey });
  const data = new DataStack(app, 'Data', {
    env,
    dataKey: foundation.dataKey,
    backupKey: foundation.backupKey,
    secretsKey: foundation.secretsKey,
  });
  const compute = new ComputeStack(app, 'Compute', {
    env,
    vpc: network.vpc,
    ec2Sg: network.ec2Sg,
    dataKey: foundation.dataKey,
    backupBucket: data.backupBucket,
    storageBucket: data.storageBucket,
  });
  const stack = new ObservabilityStack(app, 'Observability', {
    env,
    instance: compute.instance,
    backupVault: data.backupVault,
    logsKey: foundation.logsKey,
    vpc: network.vpc,
    internalClientSg: network.internalClientSg,
    storageBucket: data.storageBucket,
    backupBucket: data.backupBucket,
  });
  return { t: Template.fromStack(stack), stack };
}

test('ObservabilityStack synthesizes', () => {
  const { t } = makeStack();
  expect(t).toBeDefined();
});
```

> **Note:** The exact `DataStack`/`ComputeStack` prop names above must match what Phases 2–3 actually export. If a prop name differs at implementation time (e.g. `storageBucket` vs `bucket`), adjust the harness — but keep `ObservabilityStackProps` field names exactly as in the contract, since that is the interface Phase 5 owns.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack`
Expected: FAIL — `Cannot find module '../lib/observability-stack'`.

- [ ] **Step 3: Write the minimal stack**

```ts
// cdk/lib/observability-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface ObservabilityStackProps extends StackProps {
  readonly instance: ec2.Instance;
  readonly backupVault: backup.BackupVault;
  readonly logsKey: kms.IKey;
  readonly vpc: ec2.IVpc;
  readonly internalClientSg: ec2.ISecurityGroup;
  readonly storageBucket: s3.IBucket;
  readonly backupBucket: s3.IBucket;
}

export class ObservabilityStack extends Stack {
  public readonly topic!: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    // Constructs are added in Tasks 1–9.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest observability-stack`
Expected: PASS (the smoke test).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/test/observability-stack.test.ts && git commit -m "feat(observability): ObservabilityStack skeleton + test harness"
```

---

### Task 1: SNS on-call topic (KMS-encrypted) + email subscription (spec §16)

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('KMS-encrypted SNS topic with an email subscription from context', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::SNS::Topic', 1);
  t.hasResourceProperties('AWS::SNS::Topic', {
    KmsMasterKeyId: Match.anyValue(), // encrypted with logsKey
  });
  t.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'oncall@nsightcare.com',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "SNS topic"`
Expected: FAIL — `Template has 0 resources with type AWS::SNS::Topic`.

- [ ] **Step 3: Implement (add imports + code in the constructor)**

Add imports:

```ts
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
```

Add in the constructor:

```ts
    const oncallEmail = this.node.tryGetContext('oncallEmail') as string;
    if (!oncallEmail) {
      throw new Error('ObservabilityStack requires the "oncallEmail" context value.');
    }

    (this as { topic: sns.Topic }).topic = new sns.Topic(this, 'OnCallTopic', {
      displayName: 'Supabase on-call alerts',
      masterKey: props.logsKey,
    });
    this.topic.addSubscription(new subs.EmailSubscription(oncallEmail));
```

> **Note:** `sns.Topic` accepts `masterKey: kms.IKey` for SSE. Reusing `logsKey` keeps alerting under the same segregated CMK as the log tier (spec §14/§15). The email subscription requires a one-time confirmation click by on-call after deploy (called out in Task 11 verification).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest observability-stack -t "SNS topic"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/test/observability-stack.test.ts && git commit -m "feat(observability): KMS-encrypted SNS on-call topic + email subscription"
```

---

### Task 2: CloudWatch alarm bundle → SNS + the CloudWatch-agent config asset (spec §16)

Three alarm groups, all actioned to the SNS topic: (a) `StatusCheckFailed_Instance` on the host, (b) high `CPUUtilization`, (c) `disk_used_percent ≥ 80%` on BOTH the root and data filesystems using the `CWAgent` custom namespace. Group (c) depends on the CloudWatch agent being installed on the host with a config that emits `disk`/`mem` metrics — that config is shipped here as an asset and installed by Phase 3's bootstrap (cross-phase dependency, called out below).

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Create: `cdk/assets/cwagent-config.json`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('at least three alarms are wired to the SNS topic', () => {
  const { t } = makeStack();
  // status-check + CPU + root-disk + data-disk = 4
  t.resourceCountIs('AWS::CloudWatch::Alarm', 4);
  // every alarm actions the on-call topic
  const alarms = t.findResources('AWS::CloudWatch::Alarm');
  const topicRef = Object.keys(t.findResources('AWS::SNS::Topic'))[0];
  for (const alarm of Object.values(alarms)) {
    expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain(topicRef);
  }
});

test('instance status-check and CPU alarms use EC2 metrics', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'StatusCheckFailed_Instance',
    Namespace: 'AWS/EC2',
  });
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'CPUUtilization',
    Namespace: 'AWS/EC2',
  });
});

test('root and data disk alarms use the CWAgent disk_used_percent metric at 80%', () => {
  const { t } = makeStack();
  const diskAlarms = Object.values(t.findResources('AWS::CloudWatch::Alarm'))
    .filter((a) => a.Properties.MetricName === 'disk_used_percent');
  expect(diskAlarms.length).toBe(2);
  for (const a of diskAlarms) {
    expect(a.Properties.Namespace).toBe('CWAgent');
    expect(a.Properties.Threshold).toBe(80);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "alarm"`
Expected: FAIL — `Template has 0 resources with type AWS::CloudWatch::Alarm`.

- [ ] **Step 3: Create the CloudWatch agent config asset**

```json
// cdk/assets/cwagent-config.json
{
  "agent": {
    "metrics_collection_interval": 60,
    "run_as_user": "root"
  },
  "metrics": {
    "namespace": "CWAgent",
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "disk": {
        "measurement": ["used_percent"],
        "metrics_collection_interval": 60,
        "resources": ["/", "/mnt/pgdata"]
      },
      "mem": {
        "measurement": ["mem_used_percent"],
        "metrics_collection_interval": 60
      }
    }
  }
}
```

> **Cross-phase dependency (call this out to whoever owns Phase 3):** the `disk_used_percent` metric in namespace `CWAgent` only exists if the CloudWatch agent is installed on the host and started with THIS config. Phase 3's `ComputeStack` bootstrap (user-data) MUST: (1) install `amazon-cloudwatch-agent`, (2) drop `cwagent-config.json` at `/opt/aws/amazon-cloudwatch-agent/etc/config.json`, (3) start the agent with `-a fetch-config -m ec2 -c file:.../config.json`. The `disk` `resources` MUST list the two real mount points — `/` (root) and the data-volume mount (spec §7 mounts the dedicated Postgres/Storage/functions volume; the example uses `/mnt/pgdata` — reconcile with the actual `fstab` mount path Phase 3 chooses). The alarm dimension below (`path`) must match one of those mounts. If Phase 3's mount path differs, update both this asset and the `path` dimension in Step 4.

- [ ] **Step 4: Implement the alarms (add imports + code)**

Add imports:

```ts
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
```

Add in the constructor (after the SNS topic):

```ts
    const action = new cwActions.SnsAction(this.topic);

    // (a) Instance-level status check (distinct from System check used for auto-recovery in Phase 3).
    const statusCheck = new cw.Alarm(this, 'InstanceStatusCheckAlarm', {
      alarmName: 'supabase-instance-status-check-failed',
      metric: new cw.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_Instance',
        dimensionsMap: { InstanceId: props.instance.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });
    statusCheck.addAlarmAction(action);

    // (b) CPU high.
    const cpuHigh = new cw.Alarm(this, 'CpuHighAlarm', {
      alarmName: 'supabase-cpu-high',
      metric: new cw.Metric({
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsMap: { InstanceId: props.instance.instanceId },
        statistic: 'Average',
        period: Duration.minutes(5),
      }),
      threshold: 85,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    cpuHigh.addAlarmAction(action);

    // (c) disk_used_percent >= 80% on BOTH filesystems (CWAgent namespace).
    const diskAlarm = (id: string, path: string, device: string, fstype: string) => {
      const a = new cw.Alarm(this, id, {
        alarmName: `supabase-disk-full-${id}`,
        metric: new cw.Metric({
          namespace: 'CWAgent',
          metricName: 'disk_used_percent',
          dimensionsMap: {
            InstanceId: props.instance.instanceId,
            path,
            device,
            fstype,
          },
          statistic: 'Maximum',
          period: Duration.minutes(5),
        }),
        threshold: 80,
        evaluationPeriods: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.BREACHING,
      });
      a.addAlarmAction(action);
      return a;
    };
    // Dimensions (device/fstype) depend on the host layout Phase 3 provisions; xvda1/nvme + xfs are
    // the Amazon Linux 2023 defaults. Reconcile the `path` values with the CWAgent config asset.
    diskAlarm('RootDiskAlarm', '/', 'nvme0n1p1', 'xfs');
    diskAlarm('DataDiskAlarm', '/mnt/pgdata', 'nvme1n1', 'xfs');
```

Add the `Duration` import to the existing `aws-cdk-lib` import line:

```ts
import { Stack, StackProps, Duration } from 'aws-cdk-lib';
```

> **Note:** the CWAgent metric's dimension set (`device`/`fstype`) must match exactly what the agent publishes on the host, or the alarm sits in `INSUFFICIENT_DATA` forever. Because we set `treatMissingData: BREACHING` on the disk alarms, a mismatch fails LOUD (alarm goes into ALARM), not silent — deliberate per the fail-loud principle. Verify the real dimension values in Task 11 with `aws cloudwatch list-metrics --namespace CWAgent` and adjust.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest observability-stack -t "alarm"`
Expected: PASS (all three alarm tests).

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/assets/cwagent-config.json cdk/test/observability-stack.test.ts && git commit -m "feat(observability): status-check/CPU/dual-disk alarms + CWAgent config asset"
```

---

### Task 3: Backup-failure detection — EventBridge rule → SNS (spec §16)

Silent backup failure is otherwise invisible. Match AWS Backup `Backup Job State Change` with `state = FAILED` and target the on-call SNS topic.

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('EventBridge rule on Backup Job FAILED targets the SNS topic', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.backup'],
      'detail-type': ['Backup Job State Change'],
      detail: { state: ['FAILED'] },
    },
    Targets: Match.arrayWith([
      Match.objectLike({ Arn: Match.anyValue() }),
    ]),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "Backup Job FAILED"`
Expected: FAIL — `Template has 0 resources with type AWS::Events::Rule`.

- [ ] **Step 3: Implement (add imports + code)**

Add imports:

```ts
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
```

Add in the constructor:

```ts
    const backupFailureRule = new events.Rule(this, 'BackupJobFailedRule', {
      ruleName: 'supabase-backup-job-failed',
      description: 'Fires when an AWS Backup job for the Supabase vault fails.',
      eventPattern: {
        source: ['aws.backup'],
        detailType: ['Backup Job State Change'],
        detail: {
          state: ['FAILED'],
          backupVaultName: [props.backupVault.backupVaultName],
        },
      },
    });
    backupFailureRule.addTarget(new targets.SnsTopic(this.topic));
```

> **Note:** scoping on `backupVaultName` keeps the alert specific to the Supabase vault (spec §9). AWS Backup emits to EventBridge best-effort every ~5 min. pgBackRest job failures are NOT AWS Backup events — those are alarmed via a pgBackRest exit-code → CloudWatch custom metric emitted by the host cron (documented in the restore-drill runbook, Task 10, and reconciled with Phase 3's pgBackRest cron). This rule covers the AWS Backup snapshot tier (spec §9 secondary tier).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest observability-stack -t "Backup Job FAILED"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/test/observability-stack.test.ts && git commit -m "feat(observability): EventBridge rule for Backup Job FAILED -> SNS"
```

---

### Task 4: Replication-slot lag — scheduled Lambda publishes a custom metric + alarm (spec §16)

A stuck Realtime replication slot silently retains WAL and fills the disk. A scheduled Lambda (in the VPC, reaching the DB via Supavisor `:5432` behind the `internalClientSg`) queries `pg_replication_slots`, computes the max retained-WAL bytes, publishes a `Supabase/DB` custom metric `MaxSlotRetainedWALBytes`, and an alarm on that metric notifies on-call.

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Create: `cdk/assets/slot-lag-lambda/index.py`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('scheduled Lambda in the VPC monitors replication-slot lag', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: Match.stringLikeRegexp('^python3'),
    VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
  });
  // scheduled every 5 minutes
  t.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(5 minutes)',
  });
});

test('alarm on the replication-slot retained-WAL custom metric', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'MaxSlotRetainedWALBytes',
    Namespace: 'Supabase/DB',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "replication-slot"`
Expected: FAIL — no Lambda / no matching alarm.

- [ ] **Step 3: Create the Lambda handler asset**

```python
# cdk/assets/slot-lag-lambda/index.py
"""Publishes the max retained-WAL bytes across all Postgres replication slots
as a CloudWatch custom metric. Fails LOUD: any connection/query error raises,
so the Lambda errors metric (alarmed separately or via the schedule) surfaces it.
Uses the psycopg (v3) binary shipped in the deployment package layer; the DB
connection string comes from Secrets Manager (read-only, scoped)."""
import json
import os
import boto3
import psycopg  # bundled via requirements in the asset build

NAMESPACE = "Supabase/DB"
METRIC = "MaxSlotRetainedWALBytes"

_secrets = boto3.client("secretsmanager")
_cw = boto3.client("cloudwatch")

SLOT_QUERY = """
SELECT COALESCE(
         MAX(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)),
         0
       )::bigint AS max_retained_bytes
FROM pg_replication_slots;
"""


def _dsn() -> str:
    secret_arn = os.environ["DB_SECRET_ARN"]
    raw = _secrets.get_secret_value(SecretId=secret_arn)["SecretString"]
    s = json.loads(raw)
    # Connect through Supavisor session pooler (:5432) inside the VPC.
    return (
        f"host={s['host']} port={s.get('port', 5432)} "
        f"dbname={s.get('dbname', 'postgres')} "
        f"user={s['username']} password={s['password']} "
        f"sslmode=require connect_timeout=10"
    )


def handler(event, context):  # noqa: ANN001, ARG001
    with psycopg.connect(_dsn()) as conn:
        with conn.cursor() as cur:
            cur.execute(SLOT_QUERY)
            (max_bytes,) = cur.fetchone()
    _cw.put_metric_data(
        Namespace=NAMESPACE,
        MetricData=[
            {
                "MetricName": METRIC,
                "Value": float(max_bytes),
                "Unit": "Bytes",
            }
        ],
    )
    return {"maxRetainedBytes": int(max_bytes)}
```

> **Note (dependency packaging):** `psycopg` must be bundled. The asset directory carries a `requirements.txt` (`psycopg[binary]`) and is built via `lambda.Code.fromAsset(dir, { bundling: { image: lambda.Runtime.PYTHON_3_12.bundlingImage, command: [...pip install -r requirements.txt -t /asset-output && cp -r . /asset-output] } })`. Include the `requirements.txt` file (single line `psycopg[binary]==3.2.*`) in the asset dir. If offline bundling is unavailable in CI, an alternative is a documented CloudWatch-agent host script (cron) that runs the same query via `psql` and pushes the metric with `aws cloudwatch put-metric-data` — the spec explicitly permits either approach. Pick the Lambda here for isolation from the host.

- [ ] **Step 4: Implement the Lambda + schedule + alarm (add imports + code)**

Add imports:

```ts
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
```

Add in the constructor:

```ts
    const slotLagFn = new lambda.Function(this, 'SlotLagFn', {
      functionName: 'supabase-replication-slot-lag',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'assets', 'slot-lag-lambda'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.internalClientSg], // reaches Supavisor :5432 per NetworkStack §6 rules
      environment: {
        // Phase 2 DataStack owns this secret ARN; wire it through props or SSM at implementation.
        DB_SECRET_ARN: this.node.tryGetContext('dbSecretArn') as string ?? 'REPLACE_WITH_DB_SECRET_ARN',
      },
    });
    // Least privilege: read the DB secret + put the one custom metric.
    slotLagFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'Supabase/DB' } },
    }));
    // secretsmanager:GetSecretValue on the DB secret is granted where the secret is defined
    // (DataStack) or here once the ARN is passed via props — documented as a wiring TODO.

    const slotSchedule = new events.Rule(this, 'SlotLagSchedule', {
      ruleName: 'supabase-slot-lag-schedule',
      schedule: events.Schedule.rate(Duration.minutes(5)),
    });
    slotSchedule.addTarget(new targets.LambdaFunction(slotLagFn));

    // ~1 GiB retained WAL = investigate before the disk fills.
    const slotLagAlarm = new cw.Alarm(this, 'SlotLagAlarm', {
      alarmName: 'supabase-replication-slot-retained-wal-high',
      metric: new cw.Metric({
        namespace: 'Supabase/DB',
        metricName: 'MaxSlotRetainedWALBytes',
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 1_073_741_824, // 1 GiB
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING, // no data = Lambda broken = fail loud
    });
    slotLagAlarm.addAlarmAction(action);
```

Add the `iam` import:

```ts
import * as iam from 'aws-cdk-lib/aws-iam';
```

> **Props extension note:** the props already carry `vpc` and `internalClientSg` (declared in Task 0 to satisfy this task). The `DB_SECRET_ARN` is read from context here to avoid over-coupling; the cleaner wiring is to add `readonly dbSecret: secretsmanager.ISecret` to props and call `props.dbSecret.grantRead(slotLagFn)` — do that at implementation if Phase 2's secret construct is importable. This is the ONE documented cross-stack coupling for Phase 5 beyond the contract.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest observability-stack -t "replication-slot"`
Expected: PASS (both tests). Note: the `AWS::CloudWatch::Alarm` count assertion in Task 2 now needs updating — the disk/CPU/status tests filter by metric name so they still hold, but if any test used a bare `resourceCountIs('AWS::CloudWatch::Alarm', 4)`, bump it to `5`. Update Task 2's count test accordingly and re-run.

- [ ] **Step 6: Fix the alarm count in Task 2's test**

Change the Task 2 count assertion from `4` to `5` (status + CPU + root-disk + data-disk + slot-lag):

```ts
  t.resourceCountIs('AWS::CloudWatch::Alarm', 5);
```

Run: `npx jest observability-stack`
Expected: PASS (whole suite).

- [ ] **Step 7: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/assets/slot-lag-lambda cdk/test/observability-stack.test.ts && git commit -m "feat(observability): scheduled slot-lag Lambda + custom metric alarm"
```

---

### Task 5: AWS Budget alarm with SNS + email notification (spec §16/§25)

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('monthly cost budget at the context amount with SNS + email notification', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: Match.objectLike({
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 550, Unit: 'USD' },
    }),
    NotificationsWithSubscribers: Match.arrayWith([
      Match.objectLike({
        Notification: Match.objectLike({
          ComparisonOperator: 'GREATER_THAN',
          NotificationType: 'ACTUAL',
        }),
        Subscribers: Match.arrayWith([
          Match.objectLike({ SubscriptionType: 'EMAIL', Address: 'oncall@nsightcare.com' }),
        ]),
      }),
    ]),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "budget"`
Expected: FAIL — `Template has 0 resources with type AWS::Budgets::Budget`.

- [ ] **Step 3: Implement (add import + code)**

Add import:

```ts
import * as budgets from 'aws-cdk-lib/aws-budgets';
```

Add in the constructor:

```ts
    const budgetAmount = Number(this.node.tryGetContext('monthlyBudgetUsd'));
    if (!Number.isFinite(budgetAmount) || budgetAmount <= 0) {
      throw new Error('ObservabilityStack requires a positive "monthlyBudgetUsd" context value.');
    }

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'supabase-monthly-cost',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetAmount, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'ACTUAL',
            threshold: 80, // percent of budget
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            { subscriptionType: 'EMAIL', address: oncallEmail },
            { subscriptionType: 'SNS', address: this.topic.topicArn },
          ],
        },
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            notificationType: 'FORECASTED',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: oncallEmail }],
        },
      ],
    });
```

> **Note:** `oncallEmail` is the `const` captured in Task 1 (same constructor scope). A Budget SNS subscriber requires an SNS topic policy allowing `budgets.amazonaws.com` to publish; add the topic policy statement if the deploy surfaces an access error (documented in Task 11). AWS Budgets is a global (us-east-1) service — this stack already targets us-east-1, so no special handling.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest observability-stack -t "budget"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/test/observability-stack.test.ts && git commit -m "feat(observability): monthly Budget alarm with SNS+email notifications"
```

---

### Task 6: RLS deploy gate — SQL query + wrapper script + enable-RLS template (spec §12)

The gate is a hard release blocker: any table in an exposed schema with `rowsecurity=false` OR zero policies fails the release (deny-by-default). Ships three files, validated by grep + `bash -n`/`shellcheck`.

**Files:**
- Create: `cdk/sql/rls-gate.sql`
- Create: `cdk/sql/enable-rls-template.sql`
- Create: `cdk/scripts/rls-gate.sh`
- Test: `cdk/test/rls-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/rls-gate.test.ts
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('rls-gate.sql selects offending tables from pg_tables/pg_policies', () => {
  const sql = read('sql/rls-gate.sql');
  expect(sql).toMatch(/pg_tables/);
  expect(sql).toMatch(/pg_policies/);
  expect(sql).toMatch(/rowsecurity\s*=\s*false/i);
  // exposed schemas covered
  expect(sql).toMatch(/'public'/);
  expect(sql).toMatch(/'storage'/);
});

test('enable-rls-template.sql shows ENABLE + FORCE + deny-by-default + REVOKE/GRANT', () => {
  const sql = read('sql/enable-rls-template.sql');
  expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
  expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
  expect(sql).toMatch(/CREATE POLICY/i);
  expect(sql).toMatch(/USING\s*\(\s*false\s*\)/i); // deny-by-default example
  expect(sql).toMatch(/REVOKE/i);
  expect(sql).toMatch(/GRANT/i);
});

test('rls-gate.sh is valid bash and exits non-zero on offending tables', () => {
  // static checks only (no live DB in CI)
  execSync(`bash -n ${path.join(root, 'scripts/rls-gate.sh')}`);
  const sh = read('scripts/rls-gate.sh');
  expect(sh).toMatch(/psql/);
  expect(sh).toMatch(/rls-gate\.sql/);
  expect(sh).toMatch(/exit\s+1/);
  // shellcheck if available; skip cleanly if not installed
  try {
    execSync(`shellcheck ${path.join(root, 'scripts/rls-gate.sh')}`);
  } catch (e: any) {
    if (!/not found|ENOENT/i.test(String(e.stderr ?? e.message))) throw e;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest rls-gate`
Expected: FAIL — `ENOENT` reading `sql/rls-gate.sql`.

- [ ] **Step 3: Create `cdk/sql/rls-gate.sql`**

```sql
-- cdk/sql/rls-gate.sql
-- HIPAA RLS deploy gate (spec §12): returns ONE ROW PER OFFENDING TABLE.
-- An exposed-schema table is offending if RLS is disabled OR it has zero policies.
-- Zero rows returned = gate passes. Any rows = release BLOCKED (deny-by-default).
WITH exposed AS (
  SELECT t.schemaname, t.tablename, t.rowsecurity
  FROM pg_tables t
  WHERE t.schemaname IN ('public', 'storage', 'auth', 'realtime')
),
policy_counts AS (
  SELECT p.schemaname, p.tablename, COUNT(*) AS n_policies
  FROM pg_policies p
  GROUP BY p.schemaname, p.tablename
)
SELECT e.schemaname,
       e.tablename,
       e.rowsecurity,
       COALESCE(pc.n_policies, 0) AS n_policies,
       CASE
         WHEN e.rowsecurity = false THEN 'RLS_DISABLED'
         WHEN COALESCE(pc.n_policies, 0) = 0 THEN 'NO_POLICIES'
       END AS reason
FROM exposed e
LEFT JOIN policy_counts pc
  ON pc.schemaname = e.schemaname AND pc.tablename = e.tablename
WHERE e.rowsecurity = false
   OR COALESCE(pc.n_policies, 0) = 0
ORDER BY e.schemaname, e.tablename;
```

- [ ] **Step 4: Create `cdk/sql/enable-rls-template.sql`**

```sql
-- cdk/sql/enable-rls-template.sql
-- Template for locking down a PHI-bearing table BEFORE any PHI is loaded (spec §12).
-- Replace <schema>.<table> and the policy predicates. FORCE also applies RLS to the
-- table owner so a migration role cannot accidentally bypass it.

ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <schema>.<table> FORCE  ROW LEVEL SECURITY;

-- Deny-by-default: with RLS enabled and NO permissive policy, all access is denied.
-- This explicit deny policy makes the intent unmistakable and survives a later
-- accidental "grant everyone" policy being added to the same command set.
CREATE POLICY deny_all_default ON <schema>.<table>
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Explicit per-subject access example (owner-scoped). Add real policies like this;
-- absence of a permissive policy = no rows returned = fail closed.
CREATE POLICY owner_can_select ON <schema>.<table>
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Strip default privileges so a forgotten policy fails CLOSED, then grant explicitly.
REVOKE ALL ON <schema>.<table> FROM anon, authenticated, PUBLIC;
GRANT SELECT ON <schema>.<table> TO authenticated;
```

- [ ] **Step 5: Create `cdk/scripts/rls-gate.sh`**

```bash
#!/usr/bin/env bash
# cdk/scripts/rls-gate.sh
# Runs the RLS deploy gate against the target DB. EXITS NON-ZERO if ANY exposed-schema
# table is unrestricted (RLS off or zero policies). Deny-by-default release gate (spec §12).
#
# Usage:  DATABASE_URL="postgresql://user:pass@host:5432/postgres?sslmode=require" \
#           ./rls-gate.sh
# or pass a psql conninfo string as $1. Requires: psql on PATH.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
GATE_SQL="${SCRIPT_DIR}/../sql/rls-gate.sql"

CONN="${1:-${DATABASE_URL:-}}"
if [[ -z "${CONN}" ]]; then
  echo "ERROR: provide a psql connection string via \$1 or \$DATABASE_URL" >&2
  exit 2
fi
if [[ ! -f "${GATE_SQL}" ]]; then
  echo "ERROR: gate SQL not found at ${GATE_SQL}" >&2
  exit 2
fi

# -A -t: unaligned, tuples-only so we can count result lines cleanly.
# ON_ERROR_STOP so a bad query fails LOUD instead of returning empty (false pass).
OFFENDERS="$(psql "${CONN}" \
  --no-psqlrc --quiet --tuples-only --no-align \
  --set ON_ERROR_STOP=1 \
  --file "${GATE_SQL}")"

if [[ -n "${OFFENDERS}" ]]; then
  echo "RLS GATE FAILED — unrestricted exposed-schema tables detected:" >&2
  echo "${OFFENDERS}" >&2
  echo "Every offending table must ENABLE + FORCE ROW LEVEL SECURITY and carry a policy." >&2
  exit 1
fi

echo "RLS gate passed: all exposed-schema tables are RLS-enabled with policies."
exit 0
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest rls-gate`
Expected: PASS (all three tests; `bash -n` clean; `shellcheck` clean or skipped if not installed).

- [ ] **Step 7: Commit**

```bash
cd ~/nsight-supabase && git add cdk/sql/rls-gate.sql cdk/sql/enable-rls-template.sql cdk/scripts/rls-gate.sh cdk/test/rls-gate.test.ts && git commit -m "feat(gate): RLS deploy gate SQL + wrapper + enable-RLS template"
```

---

### Task 7: pgaudit SQL + CloudTrail data events on the PHI S3 buckets (spec §15)

`pgaudit` gives attributable DML on PHI tables; CloudTrail S3 data events cover object-level access to the storage + backup buckets. The Trail is added to `ObservabilityStack`.

**Files:**
- Create: `cdk/sql/enable-pgaudit.sql`
- Modify: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/pgaudit.test.ts` (SQL grep) and append to `cdk/test/observability-stack.test.ts` (Trail)

- [ ] **Step 1: Write the failing tests**

```ts
// cdk/test/pgaudit.test.ts
import * as fs from 'fs';
import * as path from 'path';

test('enable-pgaudit.sql enables the extension and logs DML with role attribution', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'enable-pgaudit.sql'), 'utf8');
  expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgaudit/i);
  expect(sql).toMatch(/pgaudit\.log/i);
  expect(sql).toMatch(/write/i);           // DML classes
  expect(sql).toMatch(/ALTER ROLE/i);      // role-attributed logging
});
```

Append to `cdk/test/observability-stack.test.ts`:

```ts
test('CloudTrail trail records S3 data events on the PHI buckets', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::CloudTrail::Trail', 1);
  t.hasResourceProperties('AWS::CloudTrail::Trail', {
    EventSelectors: Match.arrayWith([
      Match.objectLike({
        DataResources: Match.arrayWith([
          Match.objectLike({ Type: 'AWS::S3::Object' }),
        ]),
      }),
    ]),
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest pgaudit observability-stack -t "CloudTrail"`
Expected: FAIL — missing SQL file; no `AWS::CloudTrail::Trail`.

- [ ] **Step 3: Create `cdk/sql/enable-pgaudit.sql`**

```sql
-- cdk/sql/enable-pgaudit.sql
-- HIPAA §164.312(b) audit controls (spec §15): attributable DML on PHI tables.
-- Combined with per-user JWTs (spec §12), reads/writes are attributable to a principal.

CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Session-level default: capture DDL and role/privilege changes cluster-wide.
ALTER SYSTEM SET pgaudit.log = 'ddl, role';
ALTER SYSTEM SET pgaudit.log_catalog = off;      -- reduce noise from catalog reads
ALTER SYSTEM SET pgaudit.log_parameter = off;    -- NEVER log parameters (no PHI in logs, spec §15)
ALTER SYSTEM SET pgaudit.log_relation = on;      -- one entry per relation touched
SELECT pg_reload_conf();

-- Object-level audit on the PHI-bearing roles: log all reads AND writes attributed
-- to whichever role executed them (role attribution). Apply per app role that touches PHI.
ALTER ROLE authenticated SET pgaudit.log = 'read, write';
ALTER ROLE service_role  SET pgaudit.log = 'read, write';  -- service_role reads are otherwise anonymous
-- anon should never touch PHI; capture any attempt.
ALTER ROLE anon          SET pgaudit.log = 'read, write';

-- Verify (acceptance §17): a SELECT/INSERT on a PHI table appears in the log with the acting role.
```

- [ ] **Step 4: Implement the CloudTrail trail (add import + code)**

Add imports:

```ts
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import { RemovalPolicy } from 'aws-cdk-lib';
```

Add in the constructor:

```ts
    const trail = new cloudtrail.Trail(this, 'PhiDataTrail', {
      trailName: 'supabase-phi-data-events',
      encryptionKey: props.logsKey,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: false, // single-region stack (spec §5)
      // The trail's own S3 bucket is created + retained by the construct.
    });
    trail.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // Object-level data events on the PHI buckets ONLY (not all-S3 — cost + noise).
    trail.addS3EventSelector(
      [
        { bucket: props.storageBucket },
        { bucket: props.backupBucket },
      ],
      {
        readWriteType: cloudtrail.ReadWriteType.ALL,
        includeManagementEvents: true,
      },
    );
```

> **Note:** if CloudTrail is org-managed (a delegated-admin org trail already captures data events account-wide), DO NOT create a second trail — a duplicate data-event trail doubles cost. In that case delete this Task's Trail code, keep the assertion behind a context flag `orgTrailManaged`, and document that org-trail data-event coverage for these two bucket ARNs is confirmed instead. For the Socrates account (439024109088) the default assumption is a stack-local trail; confirm with the owner in Task 11.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest pgaudit observability-stack`
Expected: PASS (pgaudit grep + CloudTrail assertion + prior suite).

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/sql/enable-pgaudit.sql cdk/lib/observability-stack.ts cdk/test/pgaudit.test.ts cdk/test/observability-stack.test.ts && git commit -m "feat(audit): pgaudit SQL + CloudTrail S3 data events on PHI buckets"
```

---

### Task 8: pg_net lockdown SQL (spec §12)

`pg_net` allows outbound HTTP from inside the DB (exfil/SSRF). Revoke EXECUTE from `anon`/`authenticated`/`PUBLIC`.

**Files:**
- Create: `cdk/sql/lockdown-pg-net.sql`
- Test: `cdk/test/pg-net.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/pg-net.test.ts
import * as fs from 'fs';
import * as path from 'path';

test('lockdown-pg-net.sql revokes EXECUTE from anon/authenticated/PUBLIC', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'lockdown-pg-net.sql'), 'utf8');
  expect(sql).toMatch(/REVOKE\s+EXECUTE/i);
  expect(sql).toMatch(/net\.http_get/i);
  expect(sql).toMatch(/net\.http_post/i);
  expect(sql).toMatch(/\bPUBLIC\b/);
  expect(sql).toMatch(/\banon\b/);
  expect(sql).toMatch(/\bauthenticated\b/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest pg-net`
Expected: FAIL — `ENOENT` reading `sql/lockdown-pg-net.sql`.

- [ ] **Step 3: Create `cdk/sql/lockdown-pg-net.sql`**

```sql
-- cdk/sql/lockdown-pg-net.sql
-- pg_net SSRF/exfil lockdown (spec §12). pg_net lets code inside Postgres make outbound
-- HTTP calls; untrusted roles must NOT be able to invoke it. If pg_net is unused in v1,
-- prefer DROP EXTENSION (uncomment below); otherwise revoke EXECUTE broadly.

-- Revoke the ability to run pg_net from every untrusted / public role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;

-- Belt-and-suspenders for the specific worker functions (in case new functions are added
-- to the schema and the blanket revoke above is re-granted by an extension upgrade).
REVOKE EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION net.http_delete(text, jsonb, jsonb, integer)         FROM PUBLIC, anon, authenticated;

-- Default privileges for FUTURE functions created in the net schema: no EXECUTE to untrusted roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA net REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- If pg_net is unused in v1 (spec §12 preference), disable it entirely instead:
-- DROP EXTENSION IF EXISTS pg_net CASCADE;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest pg-net`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/sql/lockdown-pg-net.sql cdk/test/pg-net.test.ts && git commit -m "feat(gate): pg_net EXECUTE lockdown from anon/authenticated/PUBLIC"
```

---

### Task 9: Log tiering — short-retention operational log groups + S3/Glacier archive with Object Lock (spec §15)

CloudWatch retention is expensive at 7 yr. Set operational log groups to ~90 days and export to a Glacier-tiered, Object-Locked S3 archive for the 7-yr compliance tier. Implemented via a subscription filter → Kinesis Firehose → S3 (with Object Lock + a Glacier lifecycle transition). The archive-bucket construct is the durable-tier target; the operational log groups carry short retention.

**Files:**
- Modify: `cdk/lib/observability-stack.ts`
- Test: `cdk/test/observability-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('operational log group has short (90-day) retention', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::Logs::LogGroup', {
    RetentionInDays: 90,
  });
});

test('7-year archive bucket has Object Lock and a Glacier lifecycle transition', () => {
  const { t } = makeStack();
  t.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([
        Match.objectLike({
          Transitions: Match.arrayWith([
            Match.objectLike({ StorageClass: 'GLACIER' }),
          ]),
        }),
      ]),
    }),
  });
});

test('a subscription filter ships the log group to the archive', () => {
  const { t } = makeStack();
  t.resourceCountIs('AWS::Logs::SubscriptionFilter', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest observability-stack -t "retention"`
Expected: FAIL — no matching log group / bucket / subscription filter.

- [ ] **Step 3: Implement (add imports + code)**

Add imports:

```ts
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logsDest from 'aws-cdk-lib/aws-logs-destinations';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import { Duration } from 'aws-cdk-lib'; // (already imported in Task 2)
```

Add in the constructor:

```ts
    // 7-year compliance archive: Object-Locked, Glacier-tiered, KMS-encrypted, retained.
    const archiveBucket = new s3.Bucket(this, 'LogArchiveBucket', {
      bucketName: `nsight-supabase-log-archive-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.logsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(2557)), // 7 yr
      lifecycleRules: [
        {
          id: 'to-glacier-then-retain-7yr',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
          expiration: Duration.days(2557),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Operational log group with SHORT retention (spec §15: 30–90 d for operability).
    const opsLogGroup = new logs.LogGroup(this, 'SupabaseOpsLogGroup', {
      logGroupName: '/nsight/supabase/app',
      retention: logs.RetentionDays.THREE_MONTHS, // 90 days
      encryptionKey: props.logsKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Firehose → S3 archive (the durable long-term tier).
    const archiveStream = new firehose.DeliveryStream(this, 'LogArchiveStream', {
      destination: new firehose.S3Bucket(archiveBucket, {
        dataOutputPrefix: 'cw-logs/!{timestamp:yyyy/MM/dd}/',
        bufferingInterval: Duration.minutes(5),
        encryptionKey: props.logsKey,
      }),
    });

    // Subscription filter: everything in the ops group flows to the archive.
    new logs.SubscriptionFilter(this, 'OpsToArchive', {
      logGroup: opsLogGroup,
      destination: new logsDest.FirehoseDestination(archiveStream),
      filterPattern: logs.FilterPattern.allEvents(),
    });
```

> **Note:** `aws-cdk-lib/aws-kinesisfirehose` `DeliveryStream` + `S3Bucket` destination is the stable L2 in aws-cdk-lib ^2.150 (the older alpha module is superseded). If the installed patch of 2.150 still exposes Firehose only as `@aws-cdk/aws-kinesisfirehose-alpha`, fall back to the alpha import OR use `logs.CfnDestination` + an S3 export task; the test asserts a `SubscriptionFilter` exists and short retention, so either mechanism passes. VPC flow logs (Phase 1) and this ops group both follow this tiering. The Phase 3 host CloudWatch-agent/awslogs driver should write container logs into `/nsight/supabase/app` so they inherit the 90-day + archive path (cross-phase note).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest observability-stack -t "retention"`
Expected: PASS. Re-run the whole `observability-stack` suite to confirm the added S3 bucket / log group counts didn't break earlier count assertions (none used bare bucket/log-group counts, so they should hold).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/observability-stack.ts cdk/test/observability-stack.test.ts && git commit -m "feat(observability): log tiering — 90d CW group + Object-Locked Glacier archive"
```

---

### Task 10: Operational runbooks — restore drill + major-PG upgrade (spec §9/§17/§22)

Operational deliverables (no CDK tests beyond existence). Reference the spec sections directly.

**Files:**
- Create: `docs/runbooks/restore-drill.md`
- Create: `docs/runbooks/upgrade-postgres-major.md`
- Test: `cdk/test/runbooks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/runbooks.test.ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..'); // repo root from cdk/test
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('restore-drill runbook covers WAL replay, row counts, storage round-trip, RTO, quarterly', () => {
  const md = read('docs/runbooks/restore-drill.md');
  expect(md).toMatch(/WAL replay/i);
  expect(md).toMatch(/row count/i);
  expect(md).toMatch(/Storage object round-trip/i);
  expect(md).toMatch(/RTO/);
  expect(md).toMatch(/quarterly/i);
});

test('upgrade runbook covers backup-first, drop slots, pg_upgrade, extensions, rollback', () => {
  const md = read('docs/runbooks/upgrade-postgres-major.md');
  expect(md).toMatch(/backup/i);
  expect(md).toMatch(/replication slot/i);
  expect(md).toMatch(/pg_upgrade/i);
  expect(md).toMatch(/extension/i);
  expect(md).toMatch(/rollback/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest runbooks`
Expected: FAIL — `ENOENT` on both runbook paths.

- [ ] **Step 3: Create `docs/runbooks/restore-drill.md`**

```markdown
# Runbook: Quarterly Restore Drill (spec §9, §17)

**Purpose:** Prove the latest backup is restorable end-to-end. A recovery point that has
never been restored is not a backup. Schedule: **quarterly**, tracked as a recurring ticket.

**Objectives:** RPO ≤ 5 min (WAL archiving), **RTO target < 2 h** for a full rebuild. This
drill records the **measured RTO** each run.

## Preconditions
- On-call has console + SSM access to account 439024109088 / us-east-1.
- The pgBackRest S3 backup bucket and the AWS Backup vault (Vault Lock COMPLIANCE) are healthy.
- A throwaway restore VPC subnet exists (Phase 1 provisions a private subnet in the second AZ).

## Procedure (record start time = T0)
1. **Provision a fresh instance** in the restore subnet from the same launch template
   (IMDSv2 hop-limit 1). Attach a new encrypted data volume (data CMK).
2. **Restore the latest backup:**
   - Primary path — pgBackRest PITR: `pgbackrest --stanza=supabase --type=time \
     "--target=<latest>" restore` into the new PGDATA, or
   - Portable path — `pg_restore`/`psql` from the nightly `pg_dumpall`.
3. **Start Postgres** and confirm **clean WAL replay** — check the log for
   `database system is ready to accept connections` with no `PANIC`/`FATAL`, and
   `SELECT pg_last_wal_replay_lsn();` advances to the archived tip.
4. **Validate row counts / schema:** run `\dt+` per PHI schema and compare
   `SELECT count(*)` on the top PHI tables against the production baseline recorded
   in the ticket. Zero unexpected deltas.
5. **Storage object round-trip:** using ONLY the bucket-scoped Storage credential
   (spec §10), upload a test object via the restored Storage API, read it back,
   and confirm the Postgres `storage.objects` metadata row matches (dual-store
   consistency, spec §10).
6. **Run the RLS gate** against the restored DB (`cdk/scripts/rls-gate.sh`) — must
   exit 0 (RLS survived the restore).
7. **Record measured RTO** = (time Postgres accepted connections + validation done) − T0.
   File the number in the drill ticket; if > 2 h, open a follow-up to shorten the path
   (e.g. enable Fast Snapshot Restore, spec §9).

## Teardown
- Terminate the drill instance; delete the throwaway data volume (NOT the backups).

## Backup-failure alarm check (spec §17)
- Induce a controlled AWS Backup job failure (e.g. temporarily deny the backup role
  `backup:StartBackupJob` or point a plan at a non-existent resource), confirm the
  **`supabase-backup-job-failed` EventBridge rule** fires and on-call receives the SNS
  email, then revert. See Task 11.
```

- [ ] **Step 4: Create `docs/runbooks/upgrade-postgres-major.md`**

```markdown
# Runbook: Major PostgreSQL Version Upgrade (spec §3, §22)

**Scope:** MAJOR version bumps (e.g. PG15→17). Minor/patch bumps are a separate, simpler
"pull pinned digest → `up -d`" path (spec §22) — NOT this runbook. Major bumps change the
on-disk format and require a scripted migration + planned downtime.

**Pin PG17 from day one** to avoid an immediate forced migration.

## Pre-upgrade (do NOT skip)
1. **Mandatory verified backup first (spec §9):** take a fresh pgBackRest base backup AND a
   `pg_dumpall`; run the **restore drill** (`restore-drill.md`) against the backup and confirm
   it restores clean. Do not proceed on an unverified backup.
2. **Enumerate extensions and versions:** `SELECT * FROM pg_extension;`. Check for extensions
   that may be dropped/incompatible on the target major (e.g. timescaledb, plv8) — plan their
   handling BEFORE the window.
3. **Announce a planned maintenance window** (single node → Studio 5xx during recreate).

## Upgrade
4. **Quiesce and drop active replication slots** (Realtime): `SELECT pg_drop_replication_slot(slot_name)
   FROM pg_replication_slots;` — a retained slot blocks the upgrade and is the disk-fill footgun
   (monitored by the slot-lag alarm, Task 4). Stop the Realtime/logical consumers first.
5. **Scripted `pg_upgrade`** into a NEW data directory (or `pg_dump`/restore for the portable
   path). Keep the OLD data directory intact as the rollback artifact — do not delete it.
6. **Reconcile extensions + UID ownership** on the new cluster: re-`CREATE EXTENSION`/`ALTER
   EXTENSION ... UPDATE` to match the target image's bundled versions; fix file/UID ownership.
7. **Re-run the deploy gates:** `enable-pgaudit.sql`, `lockdown-pg-net.sql`, and the RLS gate
   (`rls-gate.sh` must exit 0) against the upgraded cluster before reopening traffic.

## Post-upgrade / rollback
8. **Verify:** healthchecks green, REST/Auth/Realtime/Storage/pgvector smoke pass (spec §17),
   `ANALYZE` the database.
9. **Rollback path:** if verification fails, stop the new cluster, point the compose `db` volume
   back at the retained OLD data directory, restart on the prior pinned image digest, and reopen.
10. Only after a clean verification + a following successful nightly backup, retire the OLD data dir.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest runbooks`
Expected: PASS (both runbooks present with the required content).

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add docs/runbooks/restore-drill.md docs/runbooks/upgrade-postgres-major.md cdk/test/runbooks.test.ts && git commit -m "docs(runbooks): restore-drill + major-PG-upgrade operational runbooks"
```

---

### Task 11: Wire ObservabilityStack into the app, synth, and owner-gated deploy + verification (spec §17)

**Files:**
- Modify: `cdk/bin/nsight-supabase.ts`
- Modify: `cdk/cdk.json` (add `oncallEmail` / `monthlyBudgetUsd` context)
- Test: `cdk/test/app.test.ts` (extend the existing synth test)

- [ ] **Step 1: Add context defaults to `cdk.json`**

Add to the `context` object in `cdk/cdk.json`:

```json
    "oncallEmail": "oncall@nsightcare.com",
    "monthlyBudgetUsd": 550
```

- [ ] **Step 2: Extend the failing synth test**

The existing `cdk/test/app.test.ts` already asserts `cdk synth` succeeds for all stacks. Add a targeted assertion:

```ts
test('cdk synth includes the ObservabilityStack', () => {
  const out = execSync('npx cdk synth SupabaseObservability --quiet 2>&1', { cwd: process.cwd() }).toString();
  expect(out).not.toMatch(/Error|Exception/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest app -t "ObservabilityStack"`
Expected: FAIL — stack not wired / `SupabaseObservability` does not exist.

- [ ] **Step 4: Wire the stack in `bin/nsight-supabase.ts`**

After the existing Foundation/Network/Data/Compute wiring, add:

```ts
import { ObservabilityStack } from '../lib/observability-stack';

new ObservabilityStack(app, 'SupabaseObservability', {
  env,
  instance: compute.instance,
  backupVault: data.backupVault,
  logsKey: foundation.logsKey,
  vpc: network.vpc,
  internalClientSg: network.internalClientSg,
  storageBucket: data.storageBucket,
  backupBucket: data.backupBucket,
});
```

> Uses the `foundation` / `network` / `data` / `compute` handles the earlier phases created in this file. If any handle name differs (e.g. `dataStack`), match the existing names — do not rename them.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest app`
Expected: PASS — synth completes for all stacks including `SupabaseObservability`.

- [ ] **Step 6: Full suite + typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: `tsc` exits 0; all Jest suites pass (observability-stack, rls-gate, pgaudit, pg-net, runbooks, app + earlier phases).

- [ ] **Step 7: Commit**

```bash
cd ~/nsight-supabase && git add cdk/bin/nsight-supabase.ts cdk/cdk.json cdk/test/app.test.ts && git commit -m "feat(cdk): wire ObservabilityStack + context; synth green"
```

- [ ] **Step 8: Deploy (owner-gated — outward action against 439024109088)**

> Deployment and the induced-failure test hit the live account. Confirm with the owner before running. Requires Phases 1–4 already deployed (this stack references live `instance`/`backupVault`/buckets). `cdk bootstrap` must already be done.

Run: `npx cdk diff SupabaseObservability`
Expected: SNS topic + subscription, 5 alarms, 2 EventBridge rules (backup-failed + slot schedule), 1 Lambda, 1 Budget, 1 CloudTrail trail (+ its bucket), 1 archive bucket + log group + Firehose + subscription filter. No deletions.

Run (after owner OK): `npx cdk deploy SupabaseObservability --require-approval broadening`
Expected: `CREATE_COMPLETE`.

- [ ] **Step 9: Confirm the SNS subscription + verify alarms live**
- On-call clicks the SNS confirmation email (subscription shows `Confirmed`).
- `aws cloudwatch list-metrics --namespace CWAgent --region us-east-1` — confirm `disk_used_percent` exists with the expected `path`/`device`/`fstype` dimensions; if they differ from Task 2's alarm dimensions, reconcile and redeploy (this is the Phase 3 CloudWatch-agent dependency surfacing).

- [ ] **Step 10: Induce a backup-job failure and confirm the alarm fires (spec §17)**
- Trigger a controlled AWS Backup job failure per `docs/runbooks/restore-drill.md` (e.g. temporarily point a plan at a missing resource or deny the backup role), confirm the `supabase-backup-job-failed` rule fires and on-call receives the SNS email, then revert. Record the result.

- [ ] **Step 11: Run the RLS gate against the DB and confirm it BLOCKS on an unrestricted table (spec §12/§17)**
- From an in-VPC client (or the host via SSM): create a throwaway table in `public` WITHOUT RLS, run `DATABASE_URL=... cdk/scripts/rls-gate.sh`, confirm it prints the offending table and **exits 1**. Enable+force RLS + add a policy, re-run, confirm it **exits 0**. Drop the throwaway table.

- [ ] **Step 12: Record outputs** (SNS topic ARN, CloudTrail trail + bucket, archive bucket, budget name) and mark Phase 5 complete. This is the final phase.

---

## Self-Review (Phase 5)

**Spec coverage:**
- §16 alarm bundle + SNS on-call + Budget → Tasks 1 (SNS+email), 2 (status-check + CPU + dual `disk_used_percent`), 3 (backup-failure EventBridge→SNS), 4 (replication-slot lag Lambda+alarm), 5 (Budget). EC2 auto-recovery / `StatusCheckFailed_System` and CPU-credit alarms are owned by Phase 3's `ComputeStack` (auto-recovery alarm is part of the compute launch template per spec §7/§21) — noted, not a Phase 5 gap; Phase 5 adds the *instance*-level status check + the operational safety net.
- §12 RLS gate + `pg_net` + Realtime authz → Task 6 (gate SQL + wrapper + enable template), Task 8 (`pg_net` lockdown). Realtime authorization is a compose/GoTrue+Realtime env setting owned by Phase 3/4 (spec §12) — called out here as a config dependency, not a CDK asset; the enable-RLS template + gate enforce the DB-side control that Realtime authz relies on.
- §15 pgaudit + CloudTrail data events + log tiering + no-PHI-in-logs → Task 7 (pgaudit `log_parameter=off` enforces no-PHI-in-logs; CloudTrail S3 data events on both PHI buckets), Task 9 (90-day CW + Object-Locked Glacier archive + subscription filter).
- §9/§17/§22 RTO/RPO, restore drill, upgrade → Task 10 runbooks; §17 acceptance (backup-alarm-fires, RLS-gate-blocks) → Task 11 Steps 10–11.
- §21 `ObservabilityStack` structure → Tasks 0 + 11.
**No gaps for Phase 5 scope.**

**Placeholder scan:** all CDK/SQL/shell/config is complete and runnable. Two intentional, clearly-labeled wiring TODOs, both with a concrete resolution: (1) `DB_SECRET_ARN` for the slot-lag Lambda (read from context now; preferred is `props.dbSecret.grantRead(fn)` once Phase 2's secret is importable); (2) the CWAgent disk-alarm `path`/`device`/`fstype` dimensions and the CWAgent-config `resources` mount path must be reconciled with Phase 3's actual `fstab` mount — Task 11 Step 9 verifies against live metrics. The `<schema>.<table>` placeholders in `enable-rls-template.sql` are a template by design (spec §12 "template"), not an incomplete step.

**Type consistency vs contract:** `ObservabilityStack` + `ObservabilityStackProps` match the required contract — `instance: ec2.Instance`, `backupVault: backup.BackupVault`, `logsKey: kms.IKey`; `oncallEmail`/`monthlyBudgetUsd` read from context (never hardcoded). Documented, contract-permitted extensions: `vpc: ec2.IVpc`, `internalClientSg: ec2.ISecurityGroup` (Task 4's Lambda VPC access, which the prompt explicitly allowed), and `storageBucket`/`backupBucket: s3.IBucket` (Task 7 CloudTrail data events). Consumes upstream exports without renaming: `FoundationStack.logsKey`, `DataStack.backupVault`, `ComputeStack.instance`, `NetworkStack.vpc`/`internalClientSg`.

**Cross-phase dependency (CloudWatch agent):** the `disk_used_percent` (Task 2) and `mem_used_percent` metrics only exist if **Phase 3's `ComputeStack` bootstrap installs the CloudWatch agent** with `cdk/assets/cwagent-config.json` and starts it (`-a fetch-config -c file:.../config.json`). This is the single hard runtime dependency Phase 5 places on Phase 3; it is called out in Task 2 Step 3, and verified live in Task 11 Step 9. Disk alarms use `treatMissingData: BREACHING` so a missing agent fails LOUD rather than hiding a full disk.

**Key risks / assumptions:** (a) **CW-agent dependency** above — the disk alarms are inert until Phase 3 installs the agent; (b) **slot-lag Lambda VPC access + secret** — the Lambda must sit behind `internalClientSg` to reach Supavisor `:5432` and needs read on the DB secret (wiring TODO); `psycopg[binary]` is bundled via the asset build (offline-CI fallback = host-cron `psql` script, spec-permitted); (c) **log-tiering mechanism** — chose Firehose→S3 (Object-Locked, Glacier lifecycle) with a subscription filter; if the pinned 2.150 patch exposes Firehose only as alpha, fall back to `logs.CfnDestination`/S3-export-task (the test asserts a `SubscriptionFilter` + 90-day retention, so either passes); (d) **CloudTrail** — assumes a stack-local trail; if the org already runs a data-event trail covering these bucket ARNs, drop this trail to avoid double cost (Task 7 note, confirm in Task 11); (e) **Budget SNS subscriber** may need an SNS topic policy allowing `budgets.amazonaws.com` — add if deploy surfaces the error.
