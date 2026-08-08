# Runbook: Deploy the MarketingHub App

**Purpose:** Ship the MarketingHub web app (`web/`) as an ECS Fargate service behind
the Cognito/Google-SAML-gated ALB defined in `app-infra/` (`AppStack`). This is a
human deploy runbook — the CDK app performs no mutations on its own.

**Account / region:** `439024109088` / `us-east-1`.

**Architecture recap:** public ALB → HTTPS:443 with `authenticate-cognito` DEFAULT
action (Google Workspace SAML), single unauthenticated `/api/health` exception →
Fargate service (Next.js 15 standalone, distroless Node 24) in private subnets. The
app talks to the self-hosted MarketingHub Supabase backend (PostgREST + Storage)
with the `service_role` key; Cognito is the sole auth authority. App-layer authz is
the `marketing` Cognito group, enforced server-side.

**Networking — the app runs INSIDE the Supabase VPC.** `AppStack` does **not** create
its own VPC/NAT. It imports the Supabase VPC + subnets and makes its Fargate tasks
members of the Supabase `internalClientSg` (the SG the NetworkStack describes as
"in-VPC clients of the Supabase data API"). That membership is the ONLY thing that
lets the tasks reach the internal data-API ALB (whose SG admits `internalClientSg`
only) and resolve the private data-API hostname (`SUPABASE_URL`, in the Supabase
private hosted zone). This removes any need for VPC peering / PrivateLink between a
separate app VPC and the Supabase VPC. The public ALB lives in the imported public
subnets; the Fargate service (private subnets) also keeps its own `ServiceSg`, which
accepts container port `:3000` from the ALB SG only.

---

## 1. Prerequisites (must all be true before deploying)

### 1.1 Supabase backend is live
- The Supabase stacks in `cdk/` (Phases 1–5) are deployed and healthy in
  `439024109088 / us-east-1`.
- The **templates schema migration** `cdk/sql/2026-07-05-templates.sql` has been
  applied to the Supabase Postgres (creates `marketinghub.templates`, the FTS
  `search` column + GIN index, `service_role` grants, and deny-by-default RLS).
- The **private Storage bucket `campaign-templates`** exists (see the migration
  header). Create it once via the Supabase Storage REST API:
  ```
  POST {SUPABASE_URL}/storage/v1/bucket
  Authorization: Bearer {SERVICE_ROLE_KEY}
  Content-Type: application/json
  { "id": "campaign-templates", "name": "campaign-templates", "public": false }
  ```
  Confirm `public: false`. Files are only ever served via server-mediated signed URLs.

### 1.2 Service-role secret in Secrets Manager
- The Supabase `service_role` key is stored in **AWS Secrets Manager** in
  `439024109088 / us-east-1`.
- Capture its **complete ARN** (including the random `-XXXXXX` suffix), e.g.
  `arn:aws:secretsmanager:us-east-1:439024109088:secret:marketinghub/supabase-service-role-AbCdEf`.
  `AppStack` imports it by **complete ARN** and grants the task execution role
  read on **that exact ARN only** (no wildcard). A name-only or truncated ARN
  will break the IAM grant.
- Never paste the key value anywhere; only its ARN is referenced.

### 1.3 Google Workspace SAML app (Cognito federation)
- Reuse the existing NSight Google Workspace SAML app (single app, `idpid C00n27oyt`).
- Obtain its **SAML metadata URL** → `googleSamlMetadataUrl` context.
- In the Google Admin console, register the app callback/logout that Cognito needs
  once the User Pool exists (see step 4). Cognito rejects any `logout_uri` /
  callback not registered on both sides:
  - Callback: `https://<appHostname>/oauth2/idpresponse`
  - Logout landing: `https://<appHostname>/`
- Map the **marketing Google group → the `marketing` Cognito group** (and the admin
  Google group → `marketinghub-admins`). Group membership drives app authz; a user
  federated but not in `marketing` is redirected to `/login` and sees nothing.

### 1.4 DNS + TLS
- Public hosted zone for `nsightcare.com` exists; capture `hostedZoneId`.
- `appHostname` (default `marketinghub.nsightcare.com`) is free to create.
- The ACM cert is created + **DNS-validated by the stack** — you must be able to
  create the validation CNAME in the hosted zone (CDK does this automatically when
  the zone is a Route53 zone in this account). The cert is `RETAIN`ed.

### 1.5 Supabase VPC networking (the app runs inside it)
- The Supabase `SupabaseNetwork` stack (in `cdk/`) is deployed. Capture its
  CloudFormation Outputs — they feed the five `supabase*` networking context keys in
  §3:
  - `SupabaseVpcId` → `supabaseVpcId`
  - `SupabasePublicSubnetIds` → `supabasePublicSubnetIds` (internet-facing ALB tier)
  - `SupabasePrivateSubnetIds` → `supabasePrivateSubnetIds` (Fargate tier)
  - `SupabaseInternalClientSgId` → `supabaseInternalClientSgId`
  - `supabaseVpcAzs` = the AZ names those subnets sit in (e.g. `us-east-1a,us-east-1b`).
- The Fargate tasks join `internalClientSg`, so **no VPC peering or PrivateLink is
  needed** — the tasks reach the internal data-API ALB and resolve `SUPABASE_URL`
  (the private data-API hostname) directly within the Supabase VPC. `SUPABASE_URL`
  must therefore be the **private** data-API hostname (Supabase private hosted zone),
  not a public URL.

### 1.6 SMS campaigns schema migration
- The **SMS campaigns migration** `cdk/sql/2026-07-22-sms-campaigns.sql` has been
  applied to the Supabase Postgres (creates `marketinghub.sms_campaigns`, the
  `sms_campaign_recipients` outbox, `sms_suppressions`, `sms_webhook_events`, the
  recipient-counts view, and the `claim_due_sms_recipients()` RPC — idempotent,
  deny-by-default RLS).
- Apply migrations **in date order**: this one runs AFTER
  `2026-07-05-templates.sql` (§1.1) — it references `marketinghub.templates`.
- Apply it via SSM to the Supabase EC2 host, then `psql` inside the `supabase-db`
  container (ship the file to the host via an S3 round-trip, or paste it into a
  heredoc — it is idempotent, so re-running is safe):
  ```
  aws ssm start-session --target <supabase-instance-id> --region us-east-1
  # on the host, with the migration file present:
  sudo docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 \
    < 2026-07-22-sms-campaigns.sql
  ```
- **Then reload the PostgREST schema cache — do not skip:**
  ```
  sudo docker exec -i supabase-db psql -U postgres \
    -c "select pg_notify('pgrst','reload schema');"
  ```
  PostgREST caches the schema: until the reload, the new tables and especially
  the `claim_due_sms_recipients` RPC return **404** through the data API, so the
  dispatcher worker cannot claim anything and campaign creation fails.

### 1.6b Engagement-suite schema migration (2026-08-05)
- The **engagement-suite migration** `cdk/sql/2026-08-05-engagement-suite.sql`
  runs AFTER `2026-07-22-sms-campaigns.sql` and `2026-07-30-contact-lists.sql`
  (same SSM + `psql` + **pgrst reload** procedure as §1.6). It adds:
  - `sms_links` + `sms_link_clicks` (per-recipient tracked short links; the
    `/l/[slug]` route resolves them),
  - `sms_inbound_messages` (the reply inbox behind the webhook's inbound lane),
  - `sms_suppression_audit` (who added/removed manual STOP entries and why),
  - consent provenance columns on `contact_list_members`,
  - the `sms_campaign_engagement` view (per-campaign clicks/replies/opt-outs),
  - and it **replaces `claim_due_sms_recipients` with a 4-arg version**
    (frequency cap, default OFF). ORDER MATTERS: because the old 2-arg
    overload is dropped and re-created by the 07-22 file, this migration must
    always be (re-)applied LAST or PostgREST RPC resolution turns ambiguous.
- **Deploy order is migration-first**: app/worker images that pass the new
  4-arg RPC call fail against an un-migrated database (PostgREST 404 on the
  RPC signature), and the webhook's `inbound` kind violates the old
  `sms_webhook_events` check constraint.
- New OPTIONAL env vars (all off/unset by default — zero behavior change):
  - app: `SMS_LINK_BASE_URL` — when set (e.g. the public app origin), campaign
    creation rewrites message URLs to `<base>/l/<slug>` tracked links; unset
    means messages keep their original URLs and no click data is captured.
  - worker: `SMS_FREQ_CAP_COUNT` / `SMS_FREQ_CAP_DAYS` — both > 0 enables the
    claim-time frequency cap (rows park as `frequency_capped`, terminal).
- Production front door (when it lands): the ALB needs the unauthenticated
  `GET /l/*` listener exception (already in app-infra next to the webhook
  rule) — tracked links are clicked from recipients' phones, no Cognito.
- **Mid-create crash artifact:** an unexplained `paused` campaign nobody
  paused is a campaign whose creation crashed mid-insert (partial audience;
  with link tracking on, possibly rendered `/l/<slug>` URLs whose `sms_links`
  rows never landed). **Cancel it and re-create — never Resume it.**

### 1.7 SMS credentials secret in Secrets Manager
- Create ONE JSON secret named **`marketinghub/sms-campaigns`** in
  `439024109088 / us-east-1` with exactly these three fields:
  ```
  {"SIMPLETEXTING_API_TOKEN":"","SIMPLETEXTING_WEBHOOK_TOKEN":"","MONDAY_API_TOKEN":""}
  ```
- **It MUST be encrypted with the SAME dedicated CMK as the Supabase
  service-role secret** (the `supabaseSecretsKmsKeyArn` context value). The task
  execution roles' `kms:Decrypt` is scoped to that exact key — a secret under a
  different CMK (or the default `aws/secretsmanager` key) fails task start with
  "Access to KMS is not allowed".
  ```
  aws secretsmanager create-secret --region us-east-1 \
    --name marketinghub/sms-campaigns \
    --kms-key-id <the Supabase-secrets CMK ARN (supabaseSecretsKmsKeyArn)> \
    --secret-string '{"SIMPLETEXTING_API_TOKEN":"","SIMPLETEXTING_WEBHOOK_TOKEN":"","MONDAY_API_TOKEN":""}'
  ```
- **Fields may be empty strings.** The secret itself must exist (the stack
  imports it by ARN at synth), but the feature degrades gracefully while fields
  are empty: `/campaigns/new` shows an unconfigured callout, Settings shows
  "not set" chips, and the dispatcher worker idles with a warning instead of
  claiming rows.
- Capture the **complete ARN** (including the random `-XXXXXX` suffix) from the
  `create-secret` output → `smsSecretsArn` context (§3). Same rule as §1.2: a
  name-only or truncated ARN breaks the IAM grant.
- Minting the values:
  - `SIMPLETEXTING_WEBHOOK_TOKEN` — mint it yourself: `openssl rand -hex 32`.
    It is the shared secret between this app and the SimpleTexting webhook
    configuration (§4); never reuse another credential.
  - `MONDAY_API_TOKEN` — Monday.com admin → **Developers → API**; the token
    needs read access to the recipient boards.
  - `SIMPLETEXTING_API_TOKEN` — SimpleTexting **account settings → API**; used
    only by the dispatcher worker to send messages.
- To set values later: `aws secretsmanager put-secret-value` with the full JSON,
  then force a new deployment of BOTH ECS services — secrets are injected at
  task start, not live-reloaded.

---

## 2. Build and push the container image

From `web/`:
```
# 2.1 Log in to ECR (repo must exist; create once if not)
aws ecr describe-repositories --repository-names marketinghub-web --region us-east-1 \
  || aws ecr create-repository --repository-name marketinghub-web --region us-east-1

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 439024109088.dkr.ecr.us-east-1.amazonaws.com

# 2.2 Build (linux/amd64 — Fargate x86) and tag with an immutable version
export TAG=439024109088.dkr.ecr.us-east-1.amazonaws.com/marketinghub-web:v1
docker build --platform linux/amd64 -t "$TAG" .

# 2.3 Push
docker push "$TAG"
```
The multi-stage `web/Dockerfile` builds the Next.js standalone output on
`node:24-alpine` and runs it on `gcr.io/distroless/nodejs24` (non-root). The
container listens on `PORT=3000` and serves the unauthenticated `/api/health`.

---

## 3. Set `app-infra` context

Edit `app-infra/cdk.json` (or pass `-c key=value` on the CLI) and replace every
`REPLACE_ME` / default with the real value:

| Context key | Value |
|---|---|
| `appHostname` | `marketinghub.nsightcare.com` |
| `hostedZoneId` | the public `nsightcare.com` zone id |
| `hostedZoneName` | `nsightcare.com` |
| `googleSamlMetadataUrl` | NSight Google SAML metadata URL (§1.3) |
| `adminGroup` | `marketinghub-admins` |
| `marketingGroup` | `marketing` |
| `cognitoDomainPrefix` | `nsight-marketinghub` (Hosted-UI domain) |
| `appImageTag` | the pushed image ref, e.g. `…/marketinghub-web:v1` |
| `supabaseUrl` | private data-API URL the app calls (PostgREST + Storage); resolves only in the Supabase private hosted zone (§1.5) |
| `supabaseServiceRoleSecretArn` | the **complete** Secrets Manager ARN (§1.2) |
| `supabaseVpcId` | Supabase VPC id — from NetworkStack output `SupabaseVpcId` (§1.5) |
| `supabaseVpcAzs` | comma-separated AZ names for the VPC, e.g. `us-east-1a,us-east-1b` (the AZs of the subnets below) |
| `supabasePublicSubnetIds` | comma-separated public subnet ids (internet-facing ALB tier) — from NetworkStack output `SupabasePublicSubnetIds` |
| `supabasePrivateSubnetIds` | comma-separated private (with-egress) subnet ids (Fargate tier) — from NetworkStack output `SupabasePrivateSubnetIds` |
| `supabaseInternalClientSgId` | Supabase `internalClientSg` id — from NetworkStack output `SupabaseInternalClientSgId` (§1.5) |
| `smsSecretsArn` | the **complete** ARN of the `marketinghub/sms-campaigns` secret (§1.7), `-XXXXXX` suffix included |
| `simpletextingAccountPhone` | *(optional — omit unless your SimpleTexting account requires it)* account phone passed as `accountPhone` on sends |

`AppStack` fails loud on any missing context, so a blank value stops synth before
deploy. The five `supabase*` networking keys make the app run **inside the Supabase
VPC** — read them straight from the Supabase NetworkStack CloudFormation Outputs:
```
aws cloudformation describe-stacks --stack-name SupabaseNetwork --region us-east-1 \
  --query "Stacks[0].Outputs[?starts_with(ExportName,'Supabase')].{Export:ExportName,Value:OutputValue}" \
  --output table
```

`AppStack` injects into the task definition automatically:
- env `SUPABASE_URL`, `NEXT_PUBLIC_APP_NAME=MarketingHub`, `COGNITO_LOGOUT_URL`,
  `AWS_REGION`/`ALB_REGION` = stack region, and **`ALB_ARN` = the front-door ALB's
  ARN**. `ALB_ARN` is **required**: the app cryptographically verifies the
  `x-amzn-oidc-data` ES256 signature and asserts the token `signer` equals
  `ALB_ARN`; without it every authenticated request throws (fail-loud). It is wired
  from the same stack's ALB, so no manual value is needed.
- secret `SUPABASE_SERVICE_ROLE_KEY` from the ARN above (execution role read scoped
  to that exact ARN).
- SMS campaigns: the app container gets secrets `MONDAY_API_TOKEN` +
  `SIMPLETEXTING_WEBHOOK_TOKEN`, and the separate **dispatcher worker** task
  (same image, command override `worker.cjs`, desiredCount 1, no ALB) gets
  `SUPABASE_SERVICE_ROLE_KEY` + `SIMPLETEXTING_API_TOKEN` — all `ValueFrom` the
  §1.7 secret's JSON fields. The send token never reaches the web task.

---

## 4. Synth + deploy

From `app-infra/`:
```
npm install
npm test            # jest assertions on the synthesized template
npx cdk synth       # confirm a clean synth with your real context
npx cdk deploy      # single stack: AppStack
```

Deploy is a **single stack** (`AppStack`) — Cognito User Pool + Google SAML IdP +
app client + groups, ACM cert (DNS-validated), public ALB + WAF, Fargate service +
cluster, and the Route53 A/ALIAS record are all created together. First deploy
blocks on ACM DNS validation (automatic when the hosted zone is in-account).

**After the first deploy** (User Pool + client now exist), finish the Google side of
§1.3 if not already done: ensure the app client's callback
`https://<appHostname>/oauth2/idpresponse` and logout `https://<appHostname>/` are
accepted by the Google SAML app, and that the marketing/admin Google groups map to
the `marketing` / `marketinghub-admins` Cognito groups. Re-run `cdk deploy` only if
you changed CDK inputs.

**Also after the first deploy — configure the SimpleTexting webhooks.** In the
SimpleTexting web UI, point BOTH the **delivery-report** webhook and the
**unsubscribe** webhook at:
```
https://<appHostname>/api/webhooks/simpletexting?token=<SIMPLETEXTING_WEBHOOK_TOKEN>
```
using the token minted in §1.7. The query-string token is the endpoint's entire
auth: the ALB forwards `POST /api/webhooks/simpletexting` without Cognito
(production-only listener rule), the app 401s any other token, and every accepted
payload is stored raw in `marketinghub.sms_webhook_events` for audit. Without
these webhooks, delivery statuses never advance past `sent` and STOP replies do
not reach the suppression list.

---

## 5. Smoke test

1. **Health (unauthenticated):** the ALB target group must show healthy targets;
   `curl -sS https://<appHostname>/api/health` returns `200 {"status":"ok"}`
   WITHOUT a Cognito redirect (the `/api/health` listener exception).
2. **Auth gate:** open `https://<appHostname>/` in a browser → redirected through
   the Cognito Hosted-UI → Google Workspace SSO → back to the app. A user NOT in the
   `marketing` group lands on `/login` and sees no templates.
3. **Templates flow (as a `marketing` user):**
   - `/templates` loads (empty state on a fresh backend).
   - `/templates/new` → upload a text template → redirected to its detail/preview.
   - It appears in the grid; search by a word in its name finds it; open the preview.
   - An email template shows subject + a sandboxed HTML preview.
   - **Large body (>8 KB) — the WAF regression guard:** upload an email template
     whose HTML `body` is well over 8 KB (e.g. paste a real marketing email, or
     duplicate a block until the body exceeds ~15 KB). It MUST create successfully
     (201, redirect to detail). A `403` here means CommonRuleSet's
     `SizeRestrictions_BODY` / `CrossSiteScripting_BODY` are blocking the upload at
     the WAF edge — confirm the `ruleActionOverrides` (both set to `Count`) survived
     on the `AWSCommon` rule in `app-stack.ts` (see §7).
4. **Storage:** uploading with a file persists `storage_path`; the file downloads via
   a signed URL (never a public bucket URL).
5. **Sign-out:** `/logout` clears the ALB session and redirects via the Cognito
   Hosted-UI logout back to `/` (which re-triggers the auth flow).
6. **SMS worker heartbeat:** the worker service's CloudWatch log streams (prefix
   `marketinghub-sms-worker`) show one structured JSON `sms-dispatcher tick`
   line per ~30 s. An `SIMPLETEXTING_API_TOKEN is not configured` warning
   instead means the §1.7 secret field is still empty (the expected degraded
   state, not a failure).
7. **Self-test campaign (1 recipient):** make a Monday board containing only the
   operator's own name + phone, then create a campaign from `/campaigns/new`
   with a text template and a future send date. The SMS arrives at
   **11:30 AM ET** on that date, and the recipient row advances
   `sent → delivered` when the delivery-report webhook lands.
8. **STOP suppression:** reply STOP to the self-test SMS → a
   `marketinghub.sms_suppressions` row appears (unsubscribe webhook), and a NEW
   campaign that includes that phone marks the recipient `suppressed` at
   creation.
9. **Pause/resume mid-send:** on a multi-recipient test campaign, hit Pause
   while it is `sending` — remaining recipients stop (claimed rows release back
   to pending); Resume → the dispatcher picks them up again; no recipient
   receives a duplicate.
10. **Unconfigured degradation:** with the §1.7 secret fields empty,
    `/campaigns/new` shows the not-configured callout (naming this runbook),
    Settings shows unconfigured chips, and the worker logs the idle warning —
    nothing crashes.

---

## 6. Rollback

- **App-only regression:** build/push a prior image tag and update `appImageTag`
  context → `cdk deploy` (the service circuit breaker rolls back a failed rollout
  automatically). Or re-point the service to the previous task-def revision in ECS.
- **Stack-level:** `cdk deploy` a prior commit of `app-infra`. Note the Cognito User
  Pool and ACM cert are `RETAIN`ed — deleting the stack does NOT delete identities or
  the cert; recreate/import deliberately.

---

## 7. Notes / gotchas

- **Never** mark the `campaign-templates` bucket public. As of Wave 2 this is
  enforced, not just policy: `/api/console/storage/buckets` answers 403 to any
  attempt to make that bucket public, empty it, or delete it (see §8).
- The service-role key is server-only. It reaches the container solely as a Secrets
  Manager–sourced env at task start; it is never in the image, the task-def
  plaintext env, or the browser bundle.
- `ALB_ARN` + `AWS_REGION`/`ALB_REGION` are load-bearing for auth — do not strip them
  from the task definition.
- WAFv2 (CommonRuleSet + KnownBadInputs + IP rate limit) is REGIONAL and associated
  to the ALB; the rate limit is 2000 req/5 min per IP.
- **CommonRuleSet body-rule overrides (do NOT remove):** the `AWSCommon` managed
  rule carries a `ruleActionOverrides` block setting `SizeRestrictions_BODY` and
  `CrossSiteScripting_BODY` to `Count`. The core feature POSTs the whole template
  HTML inline in the request body (`POST /api/templates`); real email HTML exceeds
  the 8 KB body-inspection limit and trips the XSS body signature, so at their
  default `Block` these two rules 403 legitimate uploads at the edge before they
  reach Fargate. Count keeps them logged/metered without blocking. This is safe:
  stored HTML is only ever rendered in a locked `<iframe sandbox="">` preview, never
  executed. Every other CommonRuleSet rule stays at Block. The §5 smoke test's >8 KB
  upload is the regression guard for this.
- **NO PHI in SMS message bodies — SimpleTexting has not signed a BAA.** Neither
  templates nor rendered texts may contain conditions, medications, appointment
  or treatment details. The campaign composer carries a permanent warning; this
  runbook rule is the backstop. If in doubt, the message doesn't ship.
- **The suppression list is permanent.** STOP is a legal signal:
  `marketinghub.sms_suppressions` has no UI delete. Removing a row is a
  deliberate manual SQL act on the Supabase host (§1.6 access path), done only
  with fresh written consent from the recipient.
- **Cancel cannot recall an in-flight message.** Cancel/pause stop future claims
  and release already-claimed rows, but a POST already handed to SimpleTexting
  completes; the cancel confirmation in the UI says so.
- **`failed_ambiguous` review procedure:** these recipients started a send whose
  outcome is unknown (timeout / connection reset / HTTP 500) and are **never
  auto-retried**. First check whether a delivery-report webhook reconciles the
  row on its own; otherwise verify in the SimpleTexting dashboard whether the
  message actually went out, then use **Retry** (it did not) or **Mark failed**
  (it did, or you're writing it off) on the campaign detail page.
- **Never run two worker services.** The dispatcher's `desiredCount` stays **1**
  with `minHealthyPercent 0 / maximumPercent 100`, so deploys stop-then-start
  rather than overlap. `FOR UPDATE SKIP LOCKED` keeps a brief overlap
  duplicate-safe, but two steady-state workers break the send-rate throttle —
  do not scale this service up.
- **The duplicates policy is at-most-once.** A crash can leave a message unsent
  (and flagged `failed_ambiguous`), never double-sent — a missed send is the
  accepted failure mode. Resist any "just auto-retry ambiguous rows" change: a
  duplicate patient text is worse than a missed one.

---

## 8. Wave-2 Storage parity (2026-08-08)

What shipped on `/storage` — all of it behind the marketing-group gate and
proxied through Next API routes (the browser still never reaches Supabase):

- **Bucket management** (`/api/console/storage/buckets`): create / edit
  (public flag, per-bucket size limit, MIME allow-list) / empty / delete.
  Delete AND empty are type-the-bucket-name confirmed in the modal AND
  server-side (the route requires a `confirm: <name>` echo before anything
  destructive runs). The Storage API refuses to delete a non-empty bucket —
  empty it first. `campaign-templates` stays private, always — the route
  itself 403s public/empty/delete for it (§7 rule, now server-enforced).
- **Resumable (TUS) uploads** (`/api/console/storage/tus`): the browser
  toolbar's **Large files** toggle mounts an Uppy/TUS uploader with per-file
  pause/resume/retry. The classic ≤25MB multipart upload path is unchanged
  and remains the default.
- **Image transform previews** (`/api/console/storage/render`): Preview now
  renders through the storage-api `/render/image` + imgproxy pipeline with
  width/height/resize/quality/format controls and a copyable render URL.
  Covers png/jpeg/gif/webp plus avif and (sanitized) svg sources.
- **S3 protocol panel** (read-only, on `/storage`): shows the endpoint
  *shape* only — a literal `<SUPABASE_URL>/storage/v1/s3` placeholder. The
  real internal origin (and the region env) is deliberately never rendered
  into browser-served HTML: this runbook and the host config are the source
  for the literal value. SigV4 credentials (`S3_PROTOCOL_ACCESS_KEY_ID` /
  `S3_PROTOCOL_ACCESS_KEY_SECRET`) live on the Supabase host only and are
  never surfaced through the console.

### 8.1 TUS proxy notes

- The proxy injects the service-role key upstream; client cookies and
  `Authorization` never cross in either direction, and only the TUS
  allow-listed headers are forwarded. The upstream `Location` header is
  rewritten to `/api/console/storage/tus/{id}` so the internal host never
  leaks to the browser.
- `Upload-Length` is required on create and capped at **1 GiB** (413 above
  it). **But the storage host's global `FILE_SIZE_LIMIT` still wins** — the
  pinned compose (v1.26.05) sets it to `52428800` (50MB), so resumable
  uploads larger than 50MB are refused upstream until that env (and any
  bucket-level `file_size_limit`) is raised on the Supabase host.
- Client chunk size is fixed at **6MB** (Supabase requirement — do not
  change). Upload URLs expire after ~1h (self-hosted default): an upload
  paused much longer than that restarts from zero on resume.
- Creation parses `Upload-Metadata` and holds `bucketName`/`objectName` to
  the console's `isSafeBucketName`/`isSafePath` rules (400 otherwise, before
  anything reaches the upstream). The Storage API itself accepts far looser
  keys — without this check a curl user could create objects the console can
  list but never download/rename/delete. Other metadata keys pass through
  untouched, and chunk PATCHes are not re-parsed.

### 8.2 Transform availability caveat

- `/render` only works while storage-api runs with
  `ENABLE_IMAGE_TRANSFORMATION="true"` and its `imgproxy` container is
  reachable. Both hold in the pinned compose (storage-api v1.48.26 +
  imgproxy v3.30.1); our S3-backend override does not touch either setting.
- If transformation is disabled or imgproxy is down, the route answers
  **503** and the UI shows "Image transformations are unavailable" — browse /
  upload / download / bucket management keep working.
- SVG sources can pass through as `image/svg+xml`; the render route forces
  `content-disposition: attachment` + a sandboxing CSP for anything that is
  not a raster type (png/jpeg/gif/webp/avif) — same XSS guard as the
  download proxy.

---

## 9. Wave-4 per-user JWTs + real RLS (2026-08-08)

Wave 4 gives the user-facing app path a per-user identity at the database:
pages and API routes mint short-lived HS256 JWTs from the Cognito/ALB session
(`web/src/lib/userJwt.ts`), the Supabase client sends them as `Authorization`
(`getUserClient()` in `web/src/lib/supabase.ts`), and PostgREST enforces the
new `authenticated` RLS policies from `cdk/sql/2026-08-08-w4-user-rls.sql`.
Everything is behind ONE optional env var, per the §1.6b pattern.

### 9.1 Flag semantics — `SUPABASE_JWT_SECRET`

- **Presence of `SUPABASE_JWT_SECRET` is the ONLY switch.** Unset (the
  default) ⇒ `getUserClient()` returns the service_role client and the app is
  **byte-identical to today** — zero behavior change, safe to deploy the
  Wave-4 image ahead of any env work.
- Set ⇒ the 12 user-facing pages and 10 user-facing API routes send per-user
  JWTs: `role=authenticated` (module-enforced literal), `sub` = deterministic
  UUIDv5 of the lowercased email, `email`, `groups`, `app_metadata.source`
  (`alb-cognito` in prod, `preview` under `PREVIEW_AUTH`), exp = 5 min
  (default; 15 min hard max). The value is the platform `JWT_SECRET` — the
  same HS256 secret PostgREST already verifies, so no Supabase-host config
  changes at all. The `apikey` header stays the service key (Kong key-auth
  needs a known key); PostgREST takes the role from `Authorization`.
- **What stays service_role / supabase_admin FOREVER, flag or no flag:** the
  SMS dispatcher worker, the SimpleTexting webhook, the public `/l/[slug]`
  redirect, every `api/console/*` + pg-meta path, and all Storage (`.storage`)
  calls inside the repos (no `storage.objects` policies this wave).
  `claim_due_sms_recipients` keeps its service_role-only EXECUTE.

### 9.2 Cutover order — migration first, env last

1. **Apply the migration** `cdk/sql/2026-08-08-w4-user-rls.sql` (staged as
   `/tmp/apply-w4-rls.sh`): §1.6 access path but **`psql -U supabase_admin`**
   (the 2026-08-07+ convention — `postgres` is not superuser), applied AFTER
   `2026-08-06-console-sql.sql` (and every earlier marketinghub migration —
   the file also re-revokes the console tables that migration creates), then
   the mandatory pgrst schema reload (the file ends with
   `pg_notify('pgrst','reload schema')`; run the §1.6 reload anyway).
   Idempotent, never destructive, and ONE transaction: re-running it after
   the cutover (live `authenticated` traffic) is safe — the revoke-then-grant
   convergence commits atomically, and an interrupted apply rolls back whole.
2. **Verify the app is unchanged.** The env is still unset, and service_role
   BYPASSRLS ignores the new policies — re-run §5 smoke items 1–3 and confirm
   the worker heartbeat (§5.6) still ticks. Any behavior change here means
   stop: the migration is at fault, not the flag.
3. **Stage the env:** `bash /tmp/stage-w4-env.sh`. It delivers
   `SUPABASE_JWT_SECRET` as an ECS `valueFrom` on a new app task-def revision,
   sourced from the Secrets Manager secret **`nsight-supabase/app-config`**,
   JSON key **`JWT_SECRET`** (minted by the jwt-signer custom resource; the
   host `.env` is rendered FROM it — Secrets Manager is the single source of
   truth, **never copy the value from the host `.env`**). The script also
   attaches the execution-role IAM grant the task needs: app-config is a
   different secret under a different CMK than the §1.2 service-role secret,
   so without the grant the new revision fails task start.
4. **Deploy:** the script's `update-service` rolls the app service. Secrets
   inject at task start, not live — wait for rollout `COMPLETED`.
5. **Verify RLS is live via the impersonation page** (`/auth/impersonate`):
   impersonate a `marketing` user against `marketinghub.templates` → rows
   return and the echoed claims show `role: "authenticated"`; against
   `sms_webhook_events` (service-only) → a **permission-denied error**
   (`42501 permission denied for table sms_webhook_events` — the user panel
   shows an `error` count chip plus the message, not a row count). **The
   error IS the pass condition**: the migration grants `authenticated`
   nothing on service-only tables, and Postgres fails the privilege check
   before RLS is ever consulted — deny-by-default working as built. If that
   panel ever shows `0 rows` instead, a stray SELECT grant exists on the
   table — that is the failure, not the error. Every run writes an
   audit row to `marketinghub.console_impersonation_audit` — confirm it
   landed.

### 9.3 Rollback — remove the env, instant fallback

Roll the app service back to the pre-Wave-4 task-def revision (the stage
script prints the exact `update-service` command with the revision number).
The next task start has no `SUPABASE_JWT_SECRET`, so the code path reverts to
the byte-identical service_role behavior. The RLS policies can stay applied —
they are inert for BYPASSRLS roles — and there is no migration to unwind.

### 9.4 Gotchas

- **`authenticated` carries an 8s `statement_timeout`** (Supabase image
  default; `anon` gets 3s) while service_role is uncapped. A slow user-path
  query that worked under service_role can newly fail with `57014` once the
  flag is on — that is the timeout, not RLS.
- **Never add `SUPABASE_JWT_SECRET` to the worker task-def.** The dispatcher
  must keep BYPASSRLS semantics (claims, releases, status flips across all
  rows) — a per-user worker silently strands recipients.
- **Task-def drift compounds:** after staging, the live task-def differs from
  cdk by image tag, `supabaseUrl`, AND this secret. The next `cdk deploy` of
  `app-infra` must pass `appImageTag` + `supabaseUrl` overrides and fold the
  secret into the stack (context key + `ecs.Secret` + CMK grant — TODO noted
  in the stage script), or the deploy strips it and the app silently falls
  back to service_role (safe, but it reverts the auth posture unannounced).
- **The GoTrue custom-access-token hook is staged, NOT enabled:** a commented
  block in `cdk/assets/render-env.sh` (`GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED`
  / `_URI` / `_SECRETS` — plural `_SECRETS`; upstream `example.env`'s singular
  `_SECRET` is wrong) plus an inert pass-through stub
  `marketinghub.custom_access_token_hook` in the migration. GoTrue remains
  outside the front door; do not uncomment without a Wave-3 decision.
- **`contact_list_members` has no DELETE policy by design** — member removal
  rides the `contact_lists` FK `ON DELETE CASCADE`, and FK cascades bypass
  RLS. Don't "fix" it by adding a DELETE grant.
