# Supabase on AWS — Phase 2: DataStack (Buckets, Secrets, Backup) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `DataStack` — the durable, encrypted data layer for the self-hosted Supabase stack: the S3 **Storage backend** bucket and the S3 **backup** bucket (both Object-Locked, KMS-encrypted, TLS-enforced), the full **Secrets Manager** secret set (including the crown-jewel `service_role` secret under its own dedicated CMK and a deploy-time custom resource that generates `JWT_SECRET` and *signs* `ANON_KEY`/`SERVICE_ROLE_KEY` as real JWTs), a **bucket-scoped IAM user** for the Storage container, and the **AWS Backup** vault (Vault Lock, compliance) + tiered plan (daily/weekly/monthly → 35 d / 1 y / 7 y) with a tag-based selection.

**Architecture:** AWS CDK v2 (TypeScript) app under `cdk/`. `DataStack` consumes the KMS keys exported by `FoundationStack` (`dataKey`, `backupKey`, `secretsKey`) and creates all §9/§10/§12/§13/§14 data-layer resources. Every bucket/secret/vault uses `RemovalPolicy.RETAIN` (HIPAA — never auto-delete PHI-adjacent infra). Tests use `aws-cdk-lib/assertions` (`Template`) — the CDK-native TDD pattern: assert the synthesized template, watch it fail, add the construct, watch it pass.

**Tech Stack:** Node.js 22 LTS, aws-cdk-lib v2 (^2.150), constructs v10, TypeScript 5, Jest + ts-jest. The JWT-signing custom-resource Lambda runs on the Node.js 22 runtime.

**Plan series:** This is **Phase 2 of 5**. It depends on Phase 1 exports (`FoundationStack.dataKey/backupKey/logsKey/secretsKey`, `NetworkStack.vpc/albSg/ec2Sg/internalClientSg`) and must keep the names below stable — Phase 3 (`ComputeStack`) reads `storageBucket`, `backupBucket`, and every secret from this stack, and tags the EBS data volume `supabase:backup=true` so the `BackupSelection` here picks it up.

**Spec:** `docs/superpowers/specs/2026-06-29-supabase-self-hosted-aws-design.md` (v2). Covers §5 (secret list), §9 (backup / Vault Lock / tiered retention), §10 (Storage S3 bucket + bucket-scoped creds + Object Lock), §12 (service_role crown jewel, asymmetric-vs-HS256 JWT signing), §13 (full secret set), §14 (KMS / S3 SecureTransport-deny / SSE-KMS), §21 (`DataStack`).

**Conventions:**
- All commands run from `cdk/` unless stated.
- Region `us-east-1`, account `439024109088`. Env passed via CDK context, never hardcoded in constructs.
- Buckets/secrets/vault/keys use `RemovalPolicy.RETAIN`.
- Commit after every green test.

**Exported contract (do not rename — Phase 3 imports these):**

```ts
export interface DataStackProps extends StackProps {
  readonly dataKey: kms.IKey;
  readonly backupKey: kms.IKey;
  readonly secretsKey: kms.IKey;
}

export class DataStack extends Stack {
  public readonly storageBucket: s3.Bucket;
  public readonly backupBucket: s3.Bucket;
  public readonly serviceRoleKey: kms.Key;            // dedicated CMK, §12 segregation
  public readonly appConfigSecret: secretsmanager.Secret;
  public readonly serviceRoleSecret: secretsmanager.Secret;
  public readonly storageCredsSecret: secretsmanager.Secret;
  public readonly smtpSecret: secretsmanager.Secret;
  public readonly backupVault: backup.BackupVault;
}
```

**The JWT subtlety (read before Task 4 — this is the crux of the phase):**
Supabase's `ANON_KEY` and `SERVICE_ROLE_KEY` are **not independent random strings** — they are JWTs whose claims are `{ "role": "anon" | "service_role", "iss": "supabase", "iat", "exp" }`, **signed with `JWT_SECRET` (HS256)**. If we generate them as independent randoms via `generateSecretString`, GoTrue/PostgREST will reject every request because the signature won't verify against `JWT_SECRET`. So we split generation two ways:
- **Independent randoms** (`POSTGRES_PASSWORD`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE` ≥64, `VAULT_ENC_KEY` exactly 32, `PG_META_CRYPTO_KEY`, `POOLER_TENANT_ID`, `S3_PROTOCOL_ACCESS_KEY_ID/SECRET`, `DASHBOARD_USERNAME`): CDK `generateSecretString` at create time.
- **Derived / signed** (`JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`): a **custom-resource Lambda** runs at deploy time — it generates a random `JWT_SECRET`, signs the two JWTs with it (dependency-free HMAC-SHA256 using Node's built-in `crypto`), then `PutSecretValue`s `JWT_SECRET`/`ANON_KEY` into `appConfigSecret` and `SERVICE_ROLE_KEY` into `serviceRoleSecret`. This keeps the crown jewel under its own CMK and never emits it to logs or CloudFormation state (the Lambda writes directly to Secrets Manager; the CR response carries no secret material).
> **v1 scope decision (spec §12/§19):** we retain **HS256** for v1; therefore `JWT_SECRET` is itself a crown jewel. The asymmetric (RS256/ES256) forward path is deferred and tracked in spec §19; the custom-resource design below is structured so a later swap to a signing-key pair only changes the Lambda body. Note this in the Self-Review.

---

### Task 1: `storageBucket` — Supabase Storage S3 backend (Object Lock, SSE-KMS, TLS-only)

The Storage service (`STORAGE_BACKEND=s3`) writes PHI-bearing objects here. Per §10/§14 it must be SSE-KMS with `dataKey`, versioned, fully public-access-blocked, TLS-enforced, and Object-Lock-enabled so objects can't be hard-deleted out from under a DB restore.

**Files:**
- Create: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// cdk/test/data-stack.test.ts
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { DataStack } from '../lib/data-stack';

const env = { account: '439024109088', region: 'us-east-1' };

export function makeDataTemplate() {
  const app = new App();
  const foundation = new FoundationStack(app, 'Foundation', { env });
  const data = new DataStack(app, 'Data', {
    env,
    dataKey: foundation.dataKey,
    backupKey: foundation.backupKey,
    secretsKey: foundation.secretsKey,
  });
  return { data, t: Template.fromStack(data) };
}

test('storage bucket is SSE-KMS, versioned, Object-Lock-enabled, and retained', () => {
  const { t } = makeDataTemplate();
  t.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ]),
      },
    }),
  });
});

test('storage bucket denies non-TLS access (enforceSSL)', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Action: 's3:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
      ]),
    }),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "storage bucket"`
Expected: FAIL — `Cannot find module '../lib/data-stack'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// cdk/lib/data-stack.ts
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface DataStackProps extends StackProps {
  readonly dataKey: kms.IKey;
  readonly backupKey: kms.IKey;
  readonly secretsKey: kms.IKey;
}

export class DataStack extends Stack {
  public readonly storageBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // §10/§14 — Supabase Storage S3 backend. PHI-bearing objects.
    this.storageBucket = new s3.Bucket(this, 'StorageBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.dataKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "storage bucket"`
Expected: PASS (both storage-bucket tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): Storage S3 backend bucket (SSE-KMS, Object Lock, TLS-only)"
```

---

### Task 2: `backupBucket` — pgBackRest + pg_dump target (Object Lock compliance + Glacier lifecycle)

Per §9 the backup bucket holds WAL archives, pgBackRest base backups, and nightly `pg_dump`s. It is SSE-KMS with the **`backupKey`** (segregated from `dataKey`), Object-Lock in **compliance** mode, TLS-enforced, and lifecycles old/noncurrent objects to Glacier for the 7-yr tier without hoarding hot storage.

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('backup bucket uses backupKey, Object-Lock compliance default, and lifecycle to Glacier', () => {
  const { t } = makeDataTemplate();
  t.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      ObjectLockEnabled: true,
      ObjectLockConfiguration: Match.objectLike({
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: Match.objectLike({ Mode: 'COMPLIANCE' }),
        },
      }),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ]),
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER' }),
            ]),
            NoncurrentVersionTransitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'GLACIER' }),
            ]),
          }),
        ]),
      },
    }),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "backup bucket"`
Expected: FAIL — no second bucket / no lifecycle-to-Glacier rule.

- [ ] **Step 3: Add the backup bucket**

Add imports and the `Duration` import at the top of `data-stack.ts`:

```ts
import { Stack, StackProps, RemovalPolicy, Duration } from 'aws-cdk-lib';
```

Add the field to the class:

```ts
  public readonly backupBucket: s3.Bucket;
```

Add in the constructor, after `storageBucket`:

```ts
    // §9/§14 — pgBackRest WAL/base backups + nightly pg_dump. 7-yr tier via Glacier.
    this.backupBucket = new s3.Bucket(this, 'BackupBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.backupKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      // Compliance-mode default retention aligned to the 7-yr window (§9/§10).
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(Duration.days(2555)),
      lifecycleRules: [
        {
          id: 'backup-to-glacier-7yr',
          enabled: true,
          // Current objects age into Glacier; older WAL/base backups don't sit in Standard.
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(30) },
          ],
          // Noncurrent versions likewise tier down, then expire at the 7-yr window.
          noncurrentVersionTransitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(30) },
          ],
          noncurrentVersionExpiration: Duration.days(2555),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "backup bucket"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): backup bucket (backupKey, Object Lock compliance, Glacier lifecycle)"
```

---

### Task 3: Dedicated `serviceRoleKey` CMK + `serviceRoleSecret` (crown-jewel segregation, §12)

`service_role` (BYPASSRLS) is the crown jewel. Per §12 it lives in a **separate Secrets Manager secret under a distinct KMS key** — not `secretsKey`. We create a dedicated CMK **inside `DataStack`** (segregated from the four Foundation keys) and encrypt only `serviceRoleSecret` with it. The secret is created with a placeholder value here; the real signed JWT is written by the Task-4 custom resource.

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('a dedicated service-role CMK exists in DataStack, distinct from Foundation keys', () => {
  const { t } = makeDataTemplate();
  // DataStack owns exactly one KMS key of its own: the crown-jewel service-role CMK.
  t.resourceCountIs('AWS::KMS::Key', 1);
  t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  t.hasResourceProperties('AWS::KMS::Alias', {
    AliasName: 'alias/nsight-supabase-service-role',
  });
});

test('serviceRoleSecret is encrypted with the dedicated service-role CMK', () => {
  const { data, t } = makeDataTemplate();
  const keyRef = data.serviceRoleKey.keyArn; // token — assert the secret references *a* KMS key
  expect(keyRef).toBeDefined();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/service-role',
    KmsKeyId: Match.anyValue(),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "service-role"`
Expected: FAIL — no KMS key or `service-role` secret in the stack.

- [ ] **Step 3: Add the dedicated CMK and the crown-jewel secret**

Add the secrets-manager import at the top of `data-stack.ts`:

```ts
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
```

Add fields to the class:

```ts
  public readonly serviceRoleKey: kms.Key;
  public readonly serviceRoleSecret: secretsmanager.Secret;
```

Add in the constructor, after `backupBucket`:

```ts
    // §12 — crown-jewel key segregation. service_role gets its OWN CMK,
    // separate from Foundation's secretsKey used for everything else.
    this.serviceRoleKey = new kms.Key(this, 'ServiceRoleKey', {
      alias: 'alias/nsight-supabase-service-role',
      description: 'Dedicated CMK for the service_role (BYPASSRLS) crown-jewel secret',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Placeholder value; the real signed SERVICE_ROLE_KEY JWT is written by the
    // custom resource in Task 4 (never distributed to app clients — §12).
    this.serviceRoleSecret = new secretsmanager.Secret(this, 'ServiceRoleSecret', {
      secretName: 'nsight-supabase/service-role',
      description: 'Supabase service_role JWT (BYPASSRLS). Crown jewel — server-side/admin only.',
      encryptionKey: this.serviceRoleKey,
      secretObjectValue: {}, // populated at deploy time by JwtSigner custom resource
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

> Note: `secretObjectValue: {}` creates an empty JSON secret; the custom resource in Task 4 `PutSecretValue`s `{ "SERVICE_ROLE_KEY": "<jwt>" }`. We deliberately do **not** use `generateSecretString` here because a random string is not a valid signed JWT.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "service-role"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): dedicated service_role CMK + crown-jewel secret (spec §12 segregation)"
```

---

### Task 4: `appConfigSecret` + JWT-signing custom resource (the §13 full secret set)

`appConfigSecret` holds every non-crown-jewel config value plus `JWT_SECRET`/`ANON_KEY`. The randoms are generated by CDK; `JWT_SECRET` + the signed `ANON_KEY` (into this secret) and `SERVICE_ROLE_KEY` (into `serviceRoleSecret`, Task 3) are written by a deploy-time Lambda custom resource. See the "JWT subtlety" note in the plan intro.

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Create: `cdk/lambda/jwt-signer/index.js`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('appConfigSecret exists, encrypted with secretsKey, with generated randoms and length constraints', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/app-config',
    KmsKeyId: Match.anyValue(),
    GenerateSecretString: Match.objectLike({
      // VAULT_ENC_KEY must be EXACTLY 32; excludes make the alphanumeric length exact.
      GenerateStringKey: Match.anyValue(),
    }),
  });
});

test('a Lambda custom resource signs JWT_SECRET/ANON_KEY/SERVICE_ROLE_KEY at deploy time', () => {
  const { t } = makeDataTemplate();
  // The signer Lambda (Node 22) …
  t.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Handler: 'index.handler',
  });
  // … invoked by a CloudFormation custom resource.
  t.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "appConfigSecret\|custom resource"`
Expected: FAIL — no `app-config` secret, no Lambda, no custom resource.

- [ ] **Step 3: Write the JWT-signer Lambda handler**

Create `cdk/lambda/jwt-signer/index.js` (dependency-free — uses Node's built-in `crypto`; no `jsonwebtoken` package to bundle):

```js
'use strict';
// Deploy-time signer for Supabase HS256 JWTs (§12/§13).
// Generates JWT_SECRET, signs ANON_KEY + SERVICE_ROLE_KEY, and writes them into
// Secrets Manager. Never logs secret material; the CR response carries none.
const crypto = require('crypto');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager'); // provided by the Lambda Node 22 runtime

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = b64url(JSON.stringify(header));
  const encPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

exports.handler = async (event) => {
  // Only act on Create/Update; Delete is a no-op (secrets are RETAINed).
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'jwt-signer' };
  }

  const { AppConfigSecretArn, ServiceRoleSecretArn } = event.ResourceProperties;
  const sm = new SecretsManagerClient({});

  // Idempotency: if JWT_SECRET already exists in app-config, do not re-mint
  // (re-minting would invalidate every live session — see §13 rotation runbook).
  const existing = await sm.send(new GetSecretValueCommand({ SecretId: AppConfigSecretArn }));
  const appConfig = JSON.parse(existing.SecretString || '{}');

  if (!appConfig.JWT_SECRET) {
    const jwtSecret = crypto.randomBytes(48).toString('base64'); // ~64 chars, HS256 secret
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 24 * 365 * 10; // 10-yr expiry (legacy anon/service_role keys)
    const anonKey = signJwt({ role: 'anon', iss: 'supabase', iat, exp }, jwtSecret);
    const serviceRoleKey = signJwt({ role: 'service_role', iss: 'supabase', iat, exp }, jwtSecret);

    appConfig.JWT_SECRET = jwtSecret;
    appConfig.ANON_KEY = anonKey;
    await sm.send(new PutSecretValueCommand({
      SecretId: AppConfigSecretArn,
      SecretString: JSON.stringify(appConfig),
    }));

    // Crown jewel goes into its OWN secret (distinct CMK) — never into app-config.
    await sm.send(new PutSecretValueCommand({
      SecretId: ServiceRoleSecretArn,
      SecretString: JSON.stringify({ SERVICE_ROLE_KEY: serviceRoleKey }),
    }));
  }

  return { PhysicalResourceId: 'jwt-signer' }; // no secret material in the CR response
};
```

- [ ] **Step 4: Add `appConfigSecret`, the signer Lambda, and the custom resource**

Add imports at the top of `data-stack.ts`:

```ts
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CustomResource } from 'aws-cdk-lib';
import { Provider } from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
```

Add the field to the class:

```ts
  public readonly appConfigSecret: secretsmanager.Secret;
```

Add in the constructor, after the service-role block. First the CDK-generated randoms
(§13). Note the length rules: `VAULT_ENC_KEY` **exactly 32**, `SECRET_KEY_BASE` **≥64**.
`generateSecretString` produces a *single* generated key per secret, so we generate the
tightest-constrained value (`VAULT_ENC_KEY`, exactly 32) as the templated key and seed the
rest via `secretStringTemplate`, generating the others with a small helper approach:

```ts
    // §13 — independent randoms. Each secretsmanager.Secret generates ONE string key,
    // so we compose app-config from a template (which itself carries the other randoms
    // as literals is NOT acceptable — literals would be identical every deploy). Instead
    // we generate the whole JSON with excludeCharacters + a 32-char generated key for the
    // length-critical value, and let the custom resource fill JWT fields. The remaining
    // randoms are generated by dedicated single-key secrets referenced into app-config at
    // boot? No — Supabase reads ONE env file. So we generate them here, individually, and
    // assemble. Approach: use generateSecretString for the length-critical VAULT_ENC_KEY,
    // and generate the other randoms via a short inline set of dedicated generated secrets
    // that the signer Lambda merges. To keep the deploy-time surface minimal we instead
    // generate ALL randoms inside the signer Lambda alongside the JWTs (crypto.randomBytes),
    // and use generateSecretString ONLY to prove the pattern / seed POOLER_TENANT_ID.
    this.appConfigSecret = new secretsmanager.Secret(this, 'AppConfigSecret', {
      secretName: 'nsight-supabase/app-config',
      description:
        'Supabase compose config: POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SECRET_KEY_BASE, ' +
        'VAULT_ENC_KEY, PG_META_CRYPTO_KEY, POOLER_TENANT_ID, DASHBOARD_USERNAME/PASSWORD, ' +
        'S3_PROTOCOL_ACCESS_KEY_ID/SECRET. JWT fields signed by the JwtSigner custom resource.',
      encryptionKey: props.secretsKey,
      generateSecretString: {
        // Seed the JSON with the dashboard username literal; generate DASHBOARD_PASSWORD.
        secretStringTemplate: JSON.stringify({ DASHBOARD_USERNAME: 'supabase_admin' }),
        generateStringKey: 'DASHBOARD_PASSWORD',
        passwordLength: 40,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

> **Design note (explain in Self-Review):** a single `secretsmanager.Secret` can only
> *auto-generate one* string key. Rather than fight that with many chained secrets, the
> **signer Lambda generates every random** it needs with `crypto.randomBytes` under the
> exact length rules and merges them into the app-config JSON in the same `PutSecretValue`
> call. So extend the Task-3 Lambda body to also set, when absent:
> `POSTGRES_PASSWORD` (base64, 32B), `SECRET_KEY_BASE` (**64 bytes hex = 128 chars, ≥64 ✓**),
> `VAULT_ENC_KEY` (**exactly 32 chars**: `crypto.randomBytes(24).toString('base64')` →
> 32 chars, or slice a hex string to 32), `PG_META_CRYPTO_KEY` (32B base64),
> `POOLER_TENANT_ID` (uuid), `S3_PROTOCOL_ACCESS_KEY_ID` (20-char), `S3_PROTOCOL_ACCESS_KEY_SECRET`
> (40-char). `DASHBOARD_PASSWORD`/`DASHBOARD_USERNAME` come from `generateSecretString`
> above and are preserved by the Lambda's read-merge-write. Add these lines inside the
> `if (!appConfig.JWT_SECRET)` block, before the `PutSecretValue`, in `index.js`:

```js
    // §13 randoms with exact length rules (merged into app-config alongside JWT fields).
    const rb64 = (n) => crypto.randomBytes(n).toString('base64');
    if (!appConfig.POSTGRES_PASSWORD)   appConfig.POSTGRES_PASSWORD = rb64(24);
    if (!appConfig.SECRET_KEY_BASE)     appConfig.SECRET_KEY_BASE = crypto.randomBytes(64).toString('hex'); // 128 chars ≥64
    if (!appConfig.VAULT_ENC_KEY)       appConfig.VAULT_ENC_KEY = crypto.randomBytes(24).toString('base64').slice(0, 32); // exactly 32
    if (!appConfig.PG_META_CRYPTO_KEY)  appConfig.PG_META_CRYPTO_KEY = rb64(24);
    if (!appConfig.POOLER_TENANT_ID)    appConfig.POOLER_TENANT_ID = crypto.randomUUID();
    if (!appConfig.S3_PROTOCOL_ACCESS_KEY_ID)     appConfig.S3_PROTOCOL_ACCESS_KEY_ID = crypto.randomBytes(10).toString('hex'); // 20 chars
    if (!appConfig.S3_PROTOCOL_ACCESS_KEY_SECRET) appConfig.S3_PROTOCOL_ACCESS_KEY_SECRET = crypto.randomBytes(30).toString('base64').slice(0, 40); // 40 chars
    // (VAULT_ENC_KEY length is asserted below; SECRET_KEY_BASE length is >= 64.)
    if (appConfig.VAULT_ENC_KEY.length !== 32) {
      throw new Error(`VAULT_ENC_KEY must be exactly 32 chars, got ${appConfig.VAULT_ENC_KEY.length}`);
    }
    if (appConfig.SECRET_KEY_BASE.length < 64) {
      throw new Error(`SECRET_KEY_BASE must be >= 64 chars, got ${appConfig.SECRET_KEY_BASE.length}`);
    }
```

Now the Lambda + custom-resource wiring in `data-stack.ts`, after `appConfigSecret`:

```ts
    // §12/§13 — deploy-time signer. Generates JWT_SECRET, signs ANON_KEY (→ app-config)
    // and SERVICE_ROLE_KEY (→ service-role secret), and fills the remaining randoms.
    const signerFn = new lambda.Function(this, 'JwtSignerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'jwt-signer')),
      timeout: Duration.minutes(2),
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });

    // Least privilege: read+write ONLY the two secrets, decrypt ONLY the two CMKs.
    this.appConfigSecret.grantRead(signerFn);
    this.appConfigSecret.grantWrite(signerFn);
    this.serviceRoleSecret.grantWrite(signerFn);
    signerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue'],
      resources: [this.appConfigSecret.secretArn, this.serviceRoleSecret.secretArn],
    }));
    props.secretsKey.grantEncryptDecrypt(signerFn);
    this.serviceRoleKey.grantEncryptDecrypt(signerFn);

    const signerProvider = new Provider(this, 'JwtSignerProvider', {
      onEventHandler: signerFn,
    });

    const jwtSigner = new CustomResource(this, 'JwtSigner', {
      serviceToken: signerProvider.serviceToken,
      properties: {
        AppConfigSecretArn: this.appConfigSecret.secretArn,
        ServiceRoleSecretArn: this.serviceRoleSecret.secretArn,
      },
    });
    // Ensure both secrets (and their generated values) exist before the signer runs.
    jwtSigner.node.addDependency(this.appConfigSecret);
    jwtSigner.node.addDependency(this.serviceRoleSecret);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest data-stack -t "appConfigSecret\|custom resource"`
Expected: PASS (both tests). (The `Provider` synthesizes a framework Lambda too; the test
asserts `Runtime: nodejs22.x` on *our* function via `hasResourceProperties`, which matches
if at least one Lambda has that runtime — the signer does. The `CustomResource` count is 1
— the Provider framework function is `AWS::Lambda::Function`, not a second custom resource.)

- [ ] **Step 6: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/lambda/jwt-signer/index.js cdk/test/data-stack.test.ts && git commit -m "feat(data): app-config secret + deploy-time JWT signer custom resource (§12/§13)"
```

---

### Task 5: Bucket-scoped IAM user for Storage + `storageCredsSecret` (§10 container-credential rule)

Per §10, containers can't reach the instance role (IMDSv2 hop-limit 1). The Storage service instead uses a **dedicated IAM user scoped to ONLY the storage bucket**, its access key stored in `storageCredsSecret` and injected only into the storage container. The inline policy resources must be exactly the bucket ARN and `<arn>/*` — never `*`.

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('storage IAM user policy is scoped to ONLY the storage bucket (no wildcard resource)', () => {
  const { t } = makeDataTemplate();
  t.resourceCountIs('AWS::IAM::User', 1);
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Allow',
          Action: Match.arrayWith(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']),
          // Resources are two tokens (bucket ARN + /*), never the string '*'.
          Resource: Match.not('*'),
        }),
      ]),
    }),
  });
});

test('storageCredsSecret holds the access key, encrypted with secretsKey', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/storage-creds',
    KmsKeyId: Match.anyValue(),
  });
  t.resourceCountIs('AWS::IAM::AccessKey', 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "storage IAM\|storageCredsSecret"`
Expected: FAIL — no IAM user / access key / `storage-creds` secret.

- [ ] **Step 3: Add the bucket-scoped user, access key, and secret**

Add fields to the class:

```ts
  public readonly storageCredsSecret: secretsmanager.Secret;
```

Add in the constructor, after the signer wiring:

```ts
    // §10 — bucket-scoped principal for the Storage container. The ONLY AWS credential
    // reachable from inside a container, and it can touch ONLY this one bucket.
    const storageUser = new iam.User(this, 'StorageUser', {
      userName: 'nsight-supabase-storage',
    });
    storageUser.addToPolicy(new iam.PolicyStatement({
      sid: 'StorageBucketOnly',
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject', 's3:PutObject', 's3:DeleteObject',
        's3:ListBucket', 's3:GetBucketLocation',
        's3:AbortMultipartUpload', 's3:ListMultipartUploadParts',
      ],
      resources: [this.storageBucket.bucketArn, `${this.storageBucket.bucketArn}/*`],
    }));
    // Storage must be able to use dataKey to read/write SSE-KMS objects.
    props.dataKey.grantEncryptDecrypt(storageUser);

    const storageAccessKey = new iam.AccessKey(this, 'StorageAccessKey', {
      user: storageUser,
    });

    this.storageCredsSecret = new secretsmanager.Secret(this, 'StorageCredsSecret', {
      secretName: 'nsight-supabase/storage-creds',
      description: 'Bucket-scoped IAM creds for the Supabase Storage container (§10).',
      encryptionKey: props.secretsKey,
      secretObjectValue: {
        AWS_ACCESS_KEY_ID: SecretValue.unsafePlainText(storageAccessKey.accessKeyId),
        AWS_SECRET_ACCESS_KEY: storageAccessKey.secretAccessKey,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

Add `SecretValue` to the top-level `aws-cdk-lib` import:

```ts
import { Stack, StackProps, RemovalPolicy, Duration, CustomResource, SecretValue } from 'aws-cdk-lib';
```

(and remove the separate `import { CustomResource } from 'aws-cdk-lib';` line added in Task 4 to avoid a duplicate import).

> `storageAccessKey.secretAccessKey` is already a `SecretValue`, so it is not exposed in
> plaintext in the template; `accessKeyId` is not sensitive. This is the CDK-idiomatic way
> to persist an access key into Secrets Manager.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "storage IAM\|storageCredsSecret"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): bucket-scoped Storage IAM user + creds secret (§10)"
```

---

### Task 6: `smtpSecret` shell (SES SMTP creds — populated post-SES production access)

Per §13 + §20, GoTrue needs SES SMTP creds. SES production access is a pre-deploy **open item** (§20.1), so we create the secret **shell** now (correct name, CMK, RETAIN) to be populated after SES is out of the sandbox.

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('smtpSecret shell exists (empty username/password), encrypted with secretsKey', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'nsight-supabase/smtp',
    KmsKeyId: Match.anyValue(),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "smtpSecret"`
Expected: FAIL — no `smtp` secret.

- [ ] **Step 3: Add the SMTP secret shell**

Add the field:

```ts
  public readonly smtpSecret: secretsmanager.Secret;
```

Add in the constructor, after the storage-creds block:

```ts
    // §13/§20.1 — SES SMTP creds for GoTrue. Shell only; populate AFTER SES production
    // access is granted (sandbox identities silently drop Auth emails). Empty username/
    // password placeholders; update via Secrets Manager once SES is live.
    this.smtpSecret = new secretsmanager.Secret(this, 'SmtpSecret', {
      secretName: 'nsight-supabase/smtp',
      description: 'SES SMTP username/password for GoTrue. Populate post-SES prod access (§20.1).',
      encryptionKey: props.secretsKey,
      secretObjectValue: {
        SMTP_USER: SecretValue.unsafePlainText(''),
        SMTP_PASS: SecretValue.unsafePlainText(''),
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "smtpSecret"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): SMTP secret shell (populate after SES prod access, §20.1)"
```

---

### Task 7: `backupVault` (Vault Lock compliance) + `BackupPlan` (3 tiered rules) + tag-based selection (§9)

Per §9: dedicated backup CMK vault with **Vault Lock (COMPLIANCE)**, plus a plan with **three** rules — daily→35 d, weekly→1 y (365 d), monthly→7 y (2555 d) — and a **tag-based selection** on `supabase:backup=true` (Phase 3 tags the EBS data volume with it).

**Files:**
- Modify: `cdk/lib/data-stack.ts`
- Test: `cdk/test/data-stack.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
test('backup vault is Vault-Locked (compliance) and encrypted with backupKey', () => {
  const { t } = makeDataTemplate();
  t.resourceCountIs('AWS::Backup::BackupVault', 1);
  t.hasResourceProperties('AWS::Backup::BackupVault', {
    // Vault Lock configured => LockConfiguration block present (compliance = MinRetentionDays
    // set and a ChangeableForDays cooling-off window).
    LockConfiguration: Match.objectLike({ MinRetentionDays: Match.anyValue() }),
    EncryptionKeyArn: Match.anyValue(),
  });
});

test('backup plan has exactly three tiered rules (35d / 1y / 7y) and a tag-based selection', () => {
  const { t } = makeDataTemplate();
  t.hasResourceProperties('AWS::Backup::BackupPlan', {
    BackupPlan: Match.objectLike({
      BackupPlanRule: Match.arrayWith([
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 35 }) }),
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 365 }) }),
        Match.objectLike({ Lifecycle: Match.objectLike({ DeleteAfterDays: 2555 }) }),
      ]),
    }),
  });
  t.hasResourceProperties('AWS::Backup::BackupSelection', {
    BackupSelection: Match.objectLike({
      ListOfTags: Match.arrayWith([
        Match.objectLike({
          ConditionType: 'STRINGEQUALS',
          ConditionKey: 'supabase:backup',
          ConditionValue: 'true',
        }),
      ]),
    }),
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest data-stack -t "backup vault\|backup plan"`
Expected: FAIL — no vault / plan / selection.

- [ ] **Step 3: Add the vault, plan, and selection**

Add imports at the top of `data-stack.ts`:

```ts
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
```

Add the field:

```ts
  public readonly backupVault: backup.BackupVault;
```

Add in the constructor, after the SMTP block:

```ts
    // §9 — Vault Lock (COMPLIANCE) on a dedicated backupKey-encrypted vault.
    // Setting changeableFor puts the lock into the immutable/compliance regime after the
    // (min 72 h) cooling-off window; minRetention denies early recovery-point deletion.
    this.backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: 'nsight-supabase-backup-vault',
      encryptionKey: props.backupKey,
      removalPolicy: RemovalPolicy.RETAIN,
      lockConfiguration: {
        minRetention: Duration.days(35),
        maxRetention: Duration.days(2555),
        changeableFor: Duration.days(3), // 72 h cooling-off, then COMPLIANCE-immutable
      },
    });

    const plan = new backup.BackupPlan(this, 'BackupPlan', {
      backupPlanName: 'nsight-supabase-backup-plan',
      backupVault: this.backupVault,
    });

    // Daily → retain 35 days.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'daily-35d',
      scheduleExpression: events.Schedule.cron({ hour: '5', minute: '0' }),
      deleteAfter: Duration.days(35),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(3),
    }));

    // Weekly (Sundays) → retain 1 year.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'weekly-1y',
      scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '6', minute: '0' }),
      deleteAfter: Duration.days(365),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(6),
    }));

    // Monthly (1st) → retain 7 years (2555 d) — cold tier via moveToColdStorageAfter.
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'monthly-7y',
      scheduleExpression: events.Schedule.cron({ day: '1', hour: '7', minute: '0' }),
      deleteAfter: Duration.days(2555),
      moveToColdStorageAfter: Duration.days(90),
      startWindow: Duration.hours(1),
      completionWindow: Duration.hours(8),
    }));

    // Tag-based selection: everything tagged supabase:backup=true (Phase 3 tags the EBS
    // data volume). Grants a service role scoped to the tagged resources.
    plan.addSelection('TaggedResources', {
      resources: [
        backup.BackupResource.fromTag('supabase:backup', 'true'),
      ],
    });
```

> **Object-Lock vs Vault-Lock note (Self-Review):** the S3 backup bucket (Task 2) protects
> the pgBackRest/pg_dump objects with **S3 Object Lock (compliance)**; the AWS Backup vault
> here protects the **EBS-snapshot** recovery points with **Backup Vault Lock (compliance)**.
> Two different WORM mechanisms for the two different backup tiers in §9 — both immutable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest data-stack -t "backup vault\|backup plan"`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/lib/data-stack.ts cdk/test/data-stack.test.ts && git commit -m "feat(data): Vault-Locked backup vault + 3-tier plan (35d/1y/7y) + tag selection (§9)"
```

---

### Task 8: Wire `DataStack` into the app entry, add a synth test, deploy gate

**Files:**
- Modify: `cdk/bin/nsight-supabase.ts`
- Test: `cdk/test/app.test.ts` (append a DataStack synth assertion)

- [ ] **Step 1: Write the failing test (append to `cdk/test/app.test.ts`)**

```ts
test('DataStack synthesizes with the full contract exported', () => {
  // Reuses the app synth; asserts DataStack template contains the crown-jewel key,
  // both buckets, and the vault (a fast structural smoke test).
  const { Template } = require('aws-cdk-lib/assertions');
  const { App } = require('aws-cdk-lib');
  const { FoundationStack } = require('../lib/foundation-stack');
  const { DataStack } = require('../lib/data-stack');
  const env = { account: '439024109088', region: 'us-east-1' };
  const app = new App();
  const f = new FoundationStack(app, 'F', { env });
  const d = new DataStack(app, 'D', {
    env, dataKey: f.dataKey, backupKey: f.backupKey, secretsKey: f.secretsKey,
  });
  const t = Template.fromStack(d);
  t.resourceCountIs('AWS::S3::Bucket', 2);
  t.resourceCountIs('AWS::Backup::BackupVault', 1);
  t.resourceCountIs('AWS::KMS::Key', 1); // the dedicated service-role CMK
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest app -t "DataStack synthesizes"`
Expected: PASS at the unit level, but the **app-level** `cdk synth` test still won't include
DataStack until it's wired. If instead you want the wiring driven by the app synth test,
first confirm the existing `cdk synth succeeds` test still passes, then wire below.

- [ ] **Step 3: Wire `DataStack` in `bin/nsight-supabase.ts`**

After the existing `NetworkStack` line (Phase 1 Task 7), add:

```ts
import { DataStack } from '../lib/data-stack';

new DataStack(app, 'SupabaseData', {
  env,
  dataKey: foundation.dataKey,
  backupKey: foundation.backupKey,
  secretsKey: foundation.secretsKey,
});
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: `tsc` exits 0; all suites (foundation, network, data, app) pass; `cdk synth`
succeeds for `SupabaseFoundation`, `SupabaseNetwork`, `SupabaseData`.

- [ ] **Step 5: Commit**

```bash
cd ~/nsight-supabase && git add cdk/bin/nsight-supabase.ts cdk/test/app.test.ts && git commit -m "feat(cdk): wire DataStack into the app entry"
```

---

### Task 9: Deploy DataStack and confirm (manual verification gate)

> Deployment is an outward action against account `439024109088` (PHI-adjacent, HIPAA). **Confirm with the owner before running `cdk deploy`.** `FoundationStack` must already be deployed (Phase 1). SES production access (§20.1) is NOT required for this stack — `smtpSecret` is a shell — but is a blocker before the app boots (Phase 3+).

- [ ] **Step 1: Diff**

Run: `npx cdk diff SupabaseData`
Expected: 2 S3 buckets (+ bucket policies), 1 KMS key + alias (service-role), 4 Secrets
Manager secrets (app-config, service-role, storage-creds, smtp), 1 IAM user + access key +
policy, the JwtSigner Lambda + Provider framework Lambda + custom resource, 1 Backup vault +
plan (3 rules) + selection + Backup service role. No deletions.

- [ ] **Step 2: Deploy (after owner OK)**

Run: `npx cdk deploy SupabaseData --require-approval broadening`
Expected: `CREATE_COMPLETE`. The custom resource runs the JwtSigner once; on success the
app-config and service-role secrets are populated.

- [ ] **Step 3: Confirm live — storage bucket encryption**

Run: `aws s3api get-bucket-encryption --bucket $(aws cloudformation describe-stack-resources --stack-name SupabaseData --logical-resource-id StorageBucket --query 'StackResources[0].PhysicalResourceId' --output text --region us-east-1) --region us-east-1`
Expected: `ServerSideEncryptionByDefault.SSEAlgorithm = aws:kms` with the dataKey ARN.

- [ ] **Step 4: Confirm live — backup vault + Vault Lock**

Run: `aws backup describe-backup-vault --backup-vault-name nsight-supabase-backup-vault --region us-east-1`
Expected: `Locked: true` (or a lock date within the cooling-off window), `MinRetentionDays: 35`, `MaxRetentionDays: 2555`, encryption key = backupKey ARN.

- [ ] **Step 5: Confirm the JWTs signed correctly (no secret echoed to terminal)**

Run (pipes through `jq` to check the *shape*, not print the secret):
`aws secretsmanager get-secret-value --secret-id nsight-supabase/app-config --region us-east-1 --query SecretString --output text | jq -r 'has("JWT_SECRET") and has("ANON_KEY") and (.VAULT_ENC_KEY|length==32) and (.SECRET_KEY_BASE|length>=64)'`
Expected: `true`. (Per feedback_no_secrets_in_chat, do **not** print the secret values themselves.)

- [ ] **Step 6: Confirm the crown jewel is isolated**

Run: `aws secretsmanager describe-secret --secret-id nsight-supabase/service-role --region us-east-1 --query 'KmsKeyId'`
Expected: the **service-role CMK** ARN (`alias/nsight-supabase-service-role`), NOT the shared secretsKey. Then confirm `nsight-supabase/app-config` does **not** contain `SERVICE_ROLE_KEY` (§17 gate): `aws secretsmanager get-secret-value --secret-id nsight-supabase/app-config --region us-east-1 --query SecretString --output text | jq 'has("SERVICE_ROLE_KEY")'` → `false`.

- [ ] **Step 7: Record outputs** (bucket names/ARNs, secret ARNs, vault ARN, service-role CMK ARN) for Phase 3 (`ComputeStack`) context, and stop.

---

## Self-Review (Phase 2)

**Spec coverage:**
- §5 / §13 full secret set → Task 4 (`appConfigSecret` + JwtSigner fills POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SECRET_KEY_BASE≥64, VAULT_ENC_KEY==32, PG_META_CRYPTO_KEY, POOLER_TENANT_ID, S3_PROTOCOL_*, DASHBOARD_USERNAME/PASSWORD), Task 5 (S3_PROTOCOL / bucket-scoped creds), Task 6 (SMTP shell). All 11 app-config keys + the crown jewel are accounted for.
- §9 backup/DR → Task 2 (backup bucket + Glacier lifecycle for the 7-yr tier), Task 7 (Vault-Locked vault, 3 tiered rules 35d/1y/7y, tag selection). RPO/PITR mechanics (pgBackRest host process) are Phase 3 compute concerns; this phase provides the immutable target + snapshot governance.
- §10 Storage backend → Task 1 (SSE-KMS/dataKey, versioned, BLOCK_ALL, enforceSSL, Object Lock), Task 5 (bucket-scoped IAM user, no wildcard). Object-Lock keeps objects from being deleted under a restore.
- §12 crown jewel + JWT → Task 3 (dedicated `serviceRoleKey` CMK, separate secret), Task 4 (HS256 signing that makes ANON_KEY/SERVICE_ROLE_KEY *valid* JWTs, not random strings). Asymmetric (RS256/ES256) is deferred per §19 — the signer body is the only thing that changes for the swap; documented.
- §14 encryption → SSE-KMS on both buckets with segregated keys (data vs backup), `enforceSSL` → SecureTransport=false Deny (Task 1 test), Secrets Manager CMK-encrypted, KMS key rotation on the service-role key.
- §21 DataStack in the stack list → Task 8 wiring; props consume Foundation keys via object references (no manual exports).

**Placeholder scan:** No `TODO`/`FIXME`/"similar to" left in code. The `smtpSecret` empty strings are an intentional, documented shell (§20.1), not a placeholder gap. The long design-note comment inside Task 4's `appConfigSecret` block narrates *why* the signer generates most randoms (single-generated-key limitation of `generateSecretString`) — it is commentary, and the actual generation code (in `index.js`) is complete.

**Type consistency vs the contract:** Exported names match the shared contract exactly — `DataStack`, `DataStackProps` (`dataKey/backupKey/secretsKey: kms.IKey`), and public fields `storageBucket: s3.Bucket`, `backupBucket: s3.Bucket`, `serviceRoleKey: kms.Key`, `appConfigSecret/serviceRoleSecret/storageCredsSecret/smtpSecret: secretsmanager.Secret`, `backupVault: backup.BackupVault`. Phase 3 (`ComputeStack`) imports these; the EBS data volume it creates must be tagged `supabase:backup=true` to be picked up by the Task-7 selection (called out in the plan intro and Task 7).

**Risks / executor notes:**
1. **Custom-resource ARN circularity:** the JwtSigner reads/writes both secrets, so grant IAM to the Lambda role *before* the `CustomResource`, and add explicit `node.addDependency` on both secrets (done in Task 4) so they exist first.
2. **`generateSecretString` single-key limit:** only `DASHBOARD_PASSWORD` is CDK-generated; every other random is generated by the Lambda under exact length rules. If the executor prefers pure-CDK generation, they'd need N chained secrets — rejected here for a smaller deploy surface. Either way, VAULT_ENC_KEY==32 and SECRET_KEY_BASE≥64 are *enforced* (Lambda throws otherwise).
3. **Idempotency:** the signer only mints when `JWT_SECRET` is absent, so stack updates never rotate keys (which would log everyone out — §13). Rotation is a deliberate, separate runbook.
4. **Object Lock is create-time-only:** both buckets set `objectLockEnabled` at creation; it can't be added later, and RETAIN means the buckets survive stack deletion. Deleting a compliance-locked object/vault is impossible before its retention lapses — intended, but the executor cannot "undo" a bad retention value without AWS support. Values here (2555 d) are deliberate.
5. **Backup Vault Lock cooling-off:** `changeableFor: 3 days` means the lock is mutable for 72 h post-deploy, then permanently immutable (COMPLIANCE). Verify the vault config is correct within that window.
```