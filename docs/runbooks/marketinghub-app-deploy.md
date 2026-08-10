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

## 10. Wave-5 Realtime + Edge Functions (2026-08-08)

Wave 5 adds browser Realtime (live-refreshing Inbox / Campaign detail /
Schedule views + the `/realtime` Inspector) and the `/functions` Edge
Functions console. Everything degrades gracefully: with **nothing** from this
section applied, every page renders exactly as before and the two new
consoles show an honest "Realtime unreachable" / empty-registry state. The
browser reaches Realtime ONLY through a new ALB listener rule
(`/realtime/v1/*` → Supabase Kong :8000) — Kong is not otherwise reachable
from a browser.

### 10.1 What ships in the image vs. what the operator applies

In the image (inert until the steps below): `web/src/lib/realtime/client.ts`
(wrapper; never exports a raw Supabase client), `GET /api/realtime/token`
(503 until env lands), the `LiveRefresher` islands on the three live views,
the `/realtime` + `/functions` pages (both in the Platform nav group), and
`POST /api/console/functions/invoke`. Repo-tracked edge-function sources live
in `supabase/functions/{main,hello,embed}/index.ts` — `main`/`hello` are
VERBATIM from bundle v1.26.05; `embed` is the Wave-8 stub. New hosts
self-seed them via `cdk/lib/compute-stack.ts` → `/opt/supabase/functions-seed`
→ `bootstrap.sh` (copy-if-absent only; never clobbers host edits).

### 10.2 Apply order (each step is independently safe; do them in order)

1. **W5 SQL migration** — `bash /tmp/apply-w5-realtime.sh` (a
   `/tmp/apply-w5-realtime.sql.sh` alias execs the same file). Applies
   `cdk/sql/2026-08-08-w5-realtime.sql` as `supabase_admin`: realtime tenant
   flipped `private_only` (guarded — a NOTICE + skip on a realtime image
   without the column, see §10.4), `mh_recv`/`mh_send` policies on
   `realtime.messages` (RECEIVE on private `mh:*`; SEND on `mh:inspector:*`
   ONLY — the live-view topics `mh:inbox`/`mh:schedule`/`mh:campaigns`/
   `mh:campaign:<id>` are written exclusively by the DB triggers, so no
   user can forge `change` events that force everyone else's browser into
   refresh loops), the `marketinghub.edge_functions` registry (SELECT-only
   for `authenticated` + the restrictive anon `deny_all` backstop the
   rls-gate requires), and the ids-only broadcast triggers (`{table, op,
   id}` — no row data/PII; trigger body swallows all errors, DML can never
   fail). **postgres_changes stays OFF on purpose:** no table joins the
   `supabase_realtime` publication and no replica identity changes — with
   W4's group-wide RLS, postgres_changes would stream full rows (phone
   numbers, message bodies, raw webhook JSON) to any anon-key + user-JWT
   holder over `/realtime/v1/*`; broadcast-from-DB covers every live view.
   **Ordering:** AFTER `2026-08-08-w4-user-rls.sql` (§9.2 — the registry
   grant assumes W4's schema-usage grant) and AFTER the realtime container
   has booted once (its tenant migrations create `realtime.messages` /
   `realtime.send`; the migration FAILS LOUD otherwise — single transaction,
   nothing half-applies). The script footer prints verification selects, an
   inline rls-gate re-run (**must show ZERO rows** — a TRUE contract since
   the Wave-8 gate scoping: bundle-managed internals ride the documented
   allowlist inside `cdk/sql/rls-gate.sql`, app schemas and
   `storage.objects`/`buckets` never do; on a re-run BEFORE the W8 migration
   applies, only the `storage.objects`/`storage.buckets` backstop rows may
   appear), a `realtime.send` smoke
   row (`smoke_rows = 1`, counted over the last 10s so the documented safe
   re-run also reads 1), then restarts the realtime container so its tenant
   cache picks up `private_only` (safe pre- and post-cutover — subscribers
   degrade gracefully and reconnect).
2. **Edge-functions fix** — `bash /tmp/fix-edge-functions.sh`. The
   edge-runtime container crash-loops today because its volume
   (`/mnt/pgdata/functions`) is empty. The script bundles the repo-tracked
   sources, writes them to the volume via SSM, restarts the `functions`
   service, verifies STABLE for 60s + `curl /functions/v1/hello` through
   Kong, then upserts the registry rows (name/source/version=git-sha/
   deployed_at). **Requires step 1** (guards on the registry table). Rerun
   any time — idempotent; it is also the ongoing update path for
   `supabase/functions/**` edits.
3. **Infra deploy** — `bash /tmp/deploy-w5-infra.sh`. Drift-safe by
   construction (§7 / §9.4): derives `appImageTag`, `workerImageTag`,
   `supabaseUrl`, `smsLinkBaseUrl`, all secret/CMK ARNs and the
   VPC/subnet/SG context from the LIVE services + task-defs at run time,
   aborts on any mismatch with the Wave-5 expectations, shows the full
   `cdk diff`, and requires typing `DEPLOY-W5`. It then adds the idempotent
   SG ingress (Supabase-host SG ← ALB SG tcp/8000) and runs
   `cdk deploy MarketingHubApp` with
   `-c enableRealtimeAlb=true -c workerImageTag=… -c
   supabaseAppConfigSecretArn=… -c supabaseAppConfigKmsKeyArn=…` — creating
   the `/realtime/v1/*` listener rule (priority 25, no authenticate-cognito;
   realtime auths via apikey + short-lived user JWT) and folding the W4
   out-of-band `SUPABASE_JWT_SECRET` into cdk plus the new
   `SUPABASE_ANON_KEY`.
   **Hard prerequisite (machine-checked):** the script queries the DB over
   SSM for the W4 sentinel policy (`templates_authenticated_select`) and
   ABORTS if the W4 RLS migration is not live — with `SUPABASE_JWT_SECRET`
   present, `getUserClient()` has no service-role fallback, so an
   out-of-order run would be an app-wide outage. If the SSM check itself
   cannot run, the operator must type `W4-RLS-IS-LIVE` to proceed.
   **Wave-6 prerequisite (also machine-checked, step 3/7):** app-config must
   already carry the `LOGFLARE_PRIVATE_ACCESS_TOKEN` JSON key — the Wave-6
   app-stack wires it into the same flag-ON block, so this deploy's task-def
   references it; the script ABORTS with the seeding instruction when it is
   missing. Seeder = `/tmp/stage-w6-env.sh`, queued BEFORE this deploy
   (§11.2).
   **Worker image:** the app and worker images HAVE drifted apart
   out-of-band (live: app `parity-…` vs worker `main-…`); `app-infra` uses
   `appImageTag` for BOTH containers unless `workerImageTag` pins the worker
   — the script derives the LIVE worker image and passes it, so the
   dispatcher is never rolled onto a different build (worst case: one
   same-image fold-in restart; min 0 / max 100 keeps dispatchers
   non-overlapping). Keep passing `workerImageTag` on every future deploy
   until the worker is deliberately rebuilt. The worker task-def NEVER gains
   the JWT/anon secrets (§9.4).

### 10.3 Verify

1. Rollout `COMPLETED`; the new Realtime target group reports healthy
   (health check expects Kong's **404** at `/` — 404 IS the pass).
2. Through the SSM tunnel (localhost:8080, logged in):
   - `GET /api/realtime/token` → 200 `{token, expiresAtMs, anonKey}`
     (503 = env not landed; the app then just stays in fallback).
   - **Tunnel WS check:** the `/realtime` Inspector page shows token `ok`,
     joins its default `mh:inspector:*` topic to `live` (socket `open`,
     heartbeats ticking) — this exercises the real WebSocket upgrade through
     ALB → Kong → realtime. A join stuck at `unavailable` with token `ok`
     means the ALB rule / SG ingress / migration policies, not the app.
   - Live views: Inbox / Campaign detail / Schedule show the small "Live"
     badge; insert or update a row (e.g. simulate an inbound webhook) and
     the page refreshes itself within ~2–5s.
3. `/functions` lists `main` / `hello` / `embed` with source from the
   registry; the invoke tester runs `hello` → 200. 502 "edge runtime down" =
   step 10.2-2 not applied; 503 = `SUPABASE_URL` missing on the task-def.

### 10.4 Rollback / failure posture

- **Everything is flag-gated and additive.** Redeploying without
  `enableRealtimeAlb` removes the listener rule + target group — the synth
  is byte-identical to pre-Wave-5 (tests assert it). Flag OFF ⇒ the rule is
  simply absent.
- **Realtime unreachable = automatic fallback, not an outage.** If the rule,
  env, SG or migration is missing (or realtime later breaks), the token
  route 503s / joins fail, the wrapper reports `unavailable`, live views
  silently keep today's static render + existing mutation-driven refresh,
  and the consoles show their honest unreachable states. No user-visible
  error.
- **Caveat (printed by the deploy script too):** redeploying without the two
  `supabaseAppConfig*` contexts also strips `SUPABASE_JWT_SECRET` — that
  reverts the W4 auth posture to service_role (safe but unannounced, §9.3).
- The SQL migration needs no unwind (policies/triggers are inert without
  consumers; triggers swallow errors). The SG ingress is inert without the
  listener rule; a revoke command is printed by the deploy script.
- **`private_only` guard (accepted risk when skipped):** on a realtime image
  whose `_realtime.tenants` has no `private_only` column, the migration
  raises a NOTICE and skips — PUBLIC realtime channels then remain joinable
  by any anon-key holder through `/realtime/v1/*` (an unaudited pub/sub bus;
  NO data exposure — `mh:*` broadcasts are private-channel only and
  postgres_changes is off). Revisit when the pinned bundle is upgraded.
- Edge functions: worst case the container keeps crash-looping exactly as it
  does today; volume files are inert until a restart.

## 11. Wave-6 Logs & Reports (Logflare observability, 2026-08-08)

Wave 6 adds the `/logs` explorer (+ the `/logs/drains` capability panel) and
the `/reports` charts, all read-only and behind the marketing console gate.
The Logflare `analytics` + `vector` containers ALREADY RUN on the Supabase
host; the ONLY missing links are (a) Kong's `analytics-v1-api` route, which
the pinned bundle ships commented out, and (b) a Logflare token on the app
task-def. Until BOTH staged steps below run, every Wave-6 page renders the
honest "Analytics unavailable" state and nothing else changes — zero risk in
shipping the image first.

### 11.1 What ships in the image / repo vs. what the operator applies

In the image (inert until 11.2): `web/src/lib/console/logs.ts` (server-only
Logflare client — allowlisted per-source SQL templates only, never user SQL;
search text is bound as a quote-escaped LIKE literal, backslashes/control
characters rejected; `%`/`_` deliberately act as LIKE wildcards — the pinned
BQ→PG translator consumes backslash escapes, so escaping them cannot survive
the round-trip), the `/logs` + `/reports` pages, `/logs/drains` (an honest
static panel: Log Drains are real in Logflare 1.36.1 but deliberately NOT
enabled — they are a write surface on the management API our Kong route does
not expose; log coverage = vector→Logflare in-stack for 7 services +
CloudWatch as the infra log truth), and the `GET /api/console/logs` +
`GET /api/console/reports` routes. Both routes map the unreachable state to
**503 + `unavailable: true`** (never 400 — monitors see a service-side
condition), and the lib treats 401/404/502/503/504 from the analytics path
as unreachable: on THIS stack the pre-apply state answers **401**, not 404
(the pinned kong.yml ends with a basic-auth dashboard catch-all on `/`), and
502/503/504 mean Logflare itself is down/wedged/slow.

In the repo (first-boot persistence — a REPLACEMENT host needs NO staged
step): `cdk/assets/kong-nsight.yml` (vendored pin kong.yml with ONLY
`analytics-v1-api` uncommented, pinned to the read-only
`/api/endpoints/query/*` subpath — Logflare serves its endpoint MANAGEMENT
resources, create/update/delete under the same private token, directly under
`/api/endpoints`, which stays unrouted; marker `# nsight-w6 analytics
route`), staged by `compute-stack.ts` to the non-bundle path
`/opt/supabase/kong-nsight.yml` and mounted over the kong container's
`/home/kong/temp.yml` template target via `docker-compose.override.yml` —
bootstrap's `fetch_bundle` re-clone can never clobber it. Plus
`app-infra/lib/app-stack.ts` now wires `LOGFLARE_PRIVATE_ACCESS_TOKEN` into
the same context-flagged `supabaseAppConfigSecretArn` block as JWT/ANON, so
future flag-ON deploys keep the W6 env instead of stripping it (§9.4's drift
lesson). **No staged cdk deploy this wave — but the QUEUED flag-ON W5 deploy
(§10.2-3) now references the LOGFLARE app-config key, which is why §11.2
orders the W6 env step BEFORE it and why `/tmp/deploy-w5-infra.sh`
machine-checks the key.**

### 11.2 Apply order (relative to the W4/W5 queue)

The full batched queue is now: W4 SQL (§9.2-1) → W4 env (§9.2-3) → W5 SQL
(§10.2-1) → W5 edge fix (§10.2-2) → **W6 env (step 1 below)** → W5 infra
deploy (§10.2-3) → **W6 route (step 2 below)**.

**Why W6 env moved BEFORE the W5 deploy:** the Wave-6 `app-stack.ts` wires
`LOGFLARE_PRIVATE_ACCESS_TOKEN` into the same flag-ON block the W5 deploy
turns on, so the deploy's synthesized task-def references the app-config
JSON key that ONLY `stage-w6-env.sh` writes. Deploying first would fail
every task start (`ResourceInitializationError`) and circuit-breaker-roll-
back the entire W5 update. Two guards enforce the order:
`/tmp/deploy-w5-infra.sh` step 3/7 machine-checks
`has("LOGFLARE_PRIVATE_ACCESS_TOKEN")` and ABORTS with the seeding
instruction, and `stage-w6-env.sh`'s own prerequisite (live task-def already
carries `SUPABASE_JWT_SECRET`) is satisfied by the earlier W4 env step.

1. **Stage the env** — `bash /tmp/stage-w6-env.sh` (typed confirm
   `STAGE-W6-ENV`). Reads the token the analytics container actually accepts
   from the host's `/opt/supabase/.env` via SSM (never echoed), folds it into
   `nsight-supabase/app-config`, registers a new APP task-def revision from
   the LIVE one (never the worker) with the `valueFrom` ref, updates the
   service and waits stable. **Hard prerequisites (machine-checked):**
   (a) the live task-def must already carry `SUPABASE_JWT_SECRET` (§9.2-3) —
   that proves the execution role's app-config read/decrypt grant exists;
   (b) **default-token gate** — if the host still runs the bundle
   `.env.example` DEFAULT Logflare token (public upstream), the script
   HARD-FAILS with rotation instructions (a publicly-known token would make
   the worker-exclusion boundary and Logflare's x-api-key gate cosmetic for
   any VPC workload with SG reach to the host :8000). Risk-accepted
   override: `W6_ALLOW_DEFAULT_LOGFLARE_TOKEN=1 bash /tmp/stage-w6-env.sh`.
2. **Enable the Kong route** — `bash /tmp/enable-analytics-route.sh` (typed
   confirm `ENABLE-ANALYTICS`). Safe at ANY point in the queue. Idempotent
   (exit 0 if the file, the override marker, and the verify-curl already
   pass). **Hard gates (machine-checked on the host before anything is
   touched):** the same default-token gate as step 1 (same override env
   var), and a **pin-drift gate** — the live
   `/opt/supabase/volumes/api/kong.yml` must sha256-match the pin
   `kong-nsight.yml` was vendored from, else the mount would silently revert
   a post-recon hand-edit (reconcile into the cdk asset first;
   `W6_SKIP_KONG_PIN_CHECK=1` overrides once reconciled). Then: writes a
   PRISTINE override backup (`.bak-w6-pristine`, only while the override is
   still marker-free — guaranteed pre-W6 across partial re-runs, never
   overwritten later); `docker compose up -d kong` (a RECREATE — `restart`
   won't pick up the new mount, expect a seconds-long gateway blip); 60s
   stability watch; then an end-to-end `logs.all` query through Kong with
   the host's own token (body must contain `"result"` and no **top-level**
   `"error"` key — parsed as JSON, because log rows can legitimately contain
   the substring "error"; Logflare returns errors as 200-with-`{"error"}`),
   plus a `rest-v1` regression curl. Auto-rolls-back to the pristine backup
   on any verification failure.

Either W6 step alone is safe: route-without-env and env-without-route both
leave the pages at the honest unavailable state.

### 11.3 Verify

1. Both scripts end green (each prints its own on-host verification).
2. Through the SSM tunnel (localhost:8080, logged in):
   - `/logs` lists live `edge_logs` rows for the 1h preset; switching
     sources/severities/search keeps returning; Tail polls every 10s when
     toggled.
   - `/reports` renders API request volume / error-rate / auth / service
     charts for the 24h preset ("No data in range" on a quiet source is
     honest, not a failure).
   - `/logs/drains` shows the static capability panel (no fetch — by design).
3. Failure semantics: "Analytics unavailable" Surface = route or token not
   landed OR Logflare degraded (`[console:logs] analytics unreachable` — the
   lib maps missing env, network failures, timeouts, and 401/404/502/503/504
   from the analytics path to this state; pre-apply requests answer **401**
   on this stack, via the kong.yml basic-auth catch-all). Both API routes
   return **503 + `unavailable: true`** for it. A 400 from
   `/api/console/logs` or `/api/console/reports` = a bad query parameter or
   a real Logflare query error (the lib validates before any fetch). On
   `/reports`, a PARTIAL failure (one metric erring/timing out) keeps the
   healthy charts and shows a per-chart error panel — the page-level
   unavailable state needs ALL FIVE metrics unreachable (server and client
   use the same threshold). Postgres-source charts can be near-empty
   legitimately: the bundle db runs `log_min_messages=fatal`.

### 11.4 Rollback / failure posture

- **Route:** restore the PRISTINE override backup
  (`/opt/supabase/docker-compose.override.yml.bak-w6-pristine` — written
  only while the override was still marker-free, so it is guaranteed pre-W6
  even after partial/interrupted runs; never restore an ad-hoc copy taken
  later) and `cd /opt/supabase && docker compose --env-file .env up -d
  kong`. The enable script does this automatically when its own verification
  fails; `kong-nsight.yml` left on disk is inert without the mount. NOTE: a
  replacement host self-enables from the cdk assets — rolling back
  permanently means reverting the Wave-6 cdk asset commit too.
- **Env:** roll the app service to the previous task-def revision (exact
  command printed by the stage script). The pages degrade to the honest
  unavailable state; the extra JSON key in app-config is inert.
- **Deploy-strip caveat (§9.4/§10.4 extended):** an app-infra deploy without
  the `supabaseAppConfig*` contexts now strips `SUPABASE_JWT_SECRET`,
  `SUPABASE_ANON_KEY`, **and** `LOGFLARE_PRIVATE_ACCESS_TOKEN` together —
  all safe fallbacks, but W4 auth posture + W5 realtime + W6 logs all revert
  unannounced.
- **HEADROOM WATCH (new standing duty):** the single m6i.xlarge now serves
  interactive Logflare queries + `_analytics` Postgres load on top of
  everything else. Watch it per
  `docs/runbooks/w6-analytics-headroom.md` (host CPU/mem, analytics+kong
  container health, kong 5xx on `/analytics/*`, app `[console:logs]` error
  rates); the contingency is an instance resize in
  `cdk/lib/compute-stack.ts` (future wave, NOT this one).

## 12. Wave-7 Backups & Vault consoles + cloud posture (2026-08-08)

Wave 7 adds the `/database/backups` console (pgBackRest-fed — the cloud
Backups screen is dead self-hosted, so this is real parity), the
`/integrations/vault` secrets console (metadata-first, per-secret confirmed
reveal, metadata-only audit), the `/admin/cloud` honest-N/A panel (static,
needs nothing), and generated DB types (`scripts/gen-db-types.sh` →
`web/src/lib/database.types.ts` — dev-side tooling, NO operator step).
Everything degrades honestly: until the staged steps below run, the backups
page renders "backups status unreachable — host reporter not installed
(runbook §12)" and the vault console lists whatever `vault.secrets` already
holds (the `supabase_vault 0.3.1` extension has shipped in our pinned image
since first boot). One deliberate exception to "everything works
pre-migration": REVEALS ARE FAIL-CLOSED on the audit trail — the reveal
route inserts its metadata audit row BEFORE decrypting and refuses the
reveal (honest 400, "the audit log is unavailable") while
`marketinghub.vault_console_audit` does not exist yet, because the UI's
"the reveal is recorded in the audit log" claim must be a guarantee, not an
aspiration. Create/update/delete work in that window with best-effort audit
(a failed audit insert logs one constant-string warning in the app logs —
never request data). Nothing breaks in any partial state.

### 12.1 What ships in the image / repo vs. what the operator applies

In the image (inert-but-honest until 12.2): `lib/console/backups.ts` (reads
the latest `marketinghub.backup_status` row — the host cron's verbatim
`pgbackrest info` JSON — plus `pg_stat_archiver.last_archived_time` for the
PITR cross-check; 45-min staleness badge), `lib/console/vault.ts` (metadata
listing from `vault.secrets` columns only; reveal = a SEPARATE deliberate
id-filtered query against `vault.decrypted_secrets`; plaintext is never
logged, cached, audited, or persisted past component unmount; the reveal
route is FAIL-CLOSED on the audit insert — the metadata row lands BEFORE the
decrypt, no audit row ⇒ no plaintext — while create/update/delete audits
stay best-effort with a constant-string app-log line on failure), the three
pages, and the `/api/console/vault*` routes. `vault.secrets` +
`vault.decrypted_secrets` are in BOTH `SENSITIVE_TABLES` and
`READ_ONLY_TABLES` — the table editor refuses writes; mutations flow only
through the vault console's audited paths.

In the repo (first-boot persistence — a REPLACEMENT host needs NO staged
step): `cdk/assets/backup-status-cron` staged by `compute-stack.ts` to
`/usr/local/bin` (0750), and `bootstrap.sh` writes
`/etc/cron.d/nsight-backup-status` (`*/15min`, root) INSIDE
`setup_backups()` — so `SKIP_BACKUPS` preview stacks skip the reporter and
show the honest empty state, by design. The cron runs
`pgbackrest --stanza=supabase info --output=json` and upserts the JSON
verbatim (latest-only, id=1) via `docker exec supabase-db psql`; it parses
`status.code`, NOT the exit code (pgbackrest `info` exits 0 even for a
missing stanza), stores error payloads honestly for the console to render,
exits 0 quietly if the table is absent, and best-effort publishes CloudWatch
metric `Supabase/Backup:BackupStatusJobFailed` (no new alarm). Pile-up
guards: a non-blocking flock (`/run/lock/backup-status-cron.lock`) makes an
overlapping tick skip quietly, `timeout` bounds the pgbackrest call (300s)
and each docker-exec psql (60s, plus lock/statement_timeout in the upsert
session), and `captured_at` is stamped BEFORE the info call so a slow
capture can never pass old JSON off as fresh.

Operator artifacts: migration `cdk/sql/2026-08-08-w7-backups-vault.sql`
(creates `marketinghub.backup_status` + `marketinghub.vault_console_audit` —
metadata columns only, NO value column, ever; idempotent, single txn,
`pg_notify('pgrst','reload schema')` as the final line; APPLY AS
supabase_admin AFTER `2026-08-08-w5-realtime.sql`) and staged script
`/tmp/install-backup-status-cron.sh` (SSM skeleton per
`/tmp/fix-edge-functions.sh`, instance `i-06a9f48d434cbebc7`; heredocs
byte-identical to the cdk assets; verify = run the cron once + select
`captured_at`).

### 12.2 Apply order (slotting into the §11.2 queue)

The full batched queue is now: W4 SQL (§9.2-1) → W4 env (§9.2-3) → W5 SQL
(§10.2-1) → W5 edge fix (§10.2-2) → **W7 SQL (step 1 below)** → W6 env
(§11.2-1) → W5 infra deploy (§10.2-3) → W6 route (§11.2-2) → **W7 cron
installer (step 2 below)**.

§11.2's binding constraint is UNCHANGED: W6 env stays BEFORE the W5 infra
deploy (the deploy's task-def references the app-config key only
`stage-w6-env.sh` writes). The W7 insertions do not touch it:

- **W7 SQL slots right after the W5 SQL/edge steps** because the dated
  `cdk/sql` chain applies lexicographically and the w7 file's header orders
  it AFTER `2026-08-08-w5-realtime.sql`; keeping all SQL adjacent also means
  one psql session on the host. It has no dependency on any env/deploy/route
  step and is safe earlier or later, as long as it follows the W5 SQL.
- **W7 cron installer goes LAST** because its verify step selects from
  `marketinghub.backup_status`, which needs the W7 SQL applied. (The cron
  script itself is order-tolerant — table absent ⇒ exit 0 quietly — so a
  mis-ordering degrades gracefully; only the installer's verification would
  fail.) It is independent of every W5/W6 step.

1. **Apply the W7 migration** — `bash /tmp/apply-w7-platform.sh`. Runs the
   migration as supabase_admin on the host
   (`docker exec supabase-db psql -U supabase_admin -v ON_ERROR_STOP=1 -f …`),
   after `2026-08-08-w5-realtime.sql` in the same dated-chain pass, then an
   inline rls-gate re-run (**must show ZERO rows** for both new tables — and
   ZERO overall since the Wave-8 gate scoping, modulo the
   `storage.objects`/`buckets` rows that persist until the W8 migration
   lands their backstop), the
   grant-matrix printout, and a non-clobbering writer smoke as the postgres
   role (never overwrites a real cron payload — safe re-run; the smoke's
   placeholder row is deleted again right after the read-back, as
   supabase_admin, so no fake payload ever reaches the console). Safe to
   re-run. Until step 2, the backups page shows the honest empty
   state (table exists, no rows); vault audit rows start landing
   immediately, and reveals — fail-closed on the audit trail — become
   possible from this point.
2. **Install the backup-status reporter** — `bash
   /tmp/install-backup-status-cron.sh`. Idempotent; installs
   `/usr/local/bin/backup-status-cron` (0750) +
   `/etc/cron.d/nsight-backup-status` (0644) byte-identical to the cdk
   assets, runs the reporter once, and verifies a `captured_at` row landed.
   **NOT on preview hosts.** `SKIP_BACKUPS` preview stacks have no
   pgBackRest AT ALL by design (no backup vault; see `setup_backups()`
   above) — installing the reporter there just schedules a cron that fails
   every 15 minutes. The backups console's "host reporter not installed"
   empty state IS the correct preview behavior. If it was installed by
   mistake, remove `/etc/cron.d/nsight-backup-status` (the 2026-08-10
   preview rollout hit exactly this; removal script pattern in the ops log).

Either W7 step alone is safe: SQL-without-cron ⇒ honest empty backups page;
cron-without-SQL ⇒ the reporter no-ops quietly until the table exists.

### 12.3 Verify

1. Host: `docker exec supabase-db psql -U postgres -c "select captured_at
   from marketinghub.backup_status"` returns one recent row (the installer
   already checked this; re-check ~20 min later to see the 15-min cadence).
2. Through the SSM tunnel (localhost:8080, logged in):
   - `/database/backups` renders the stanza summary, the backups table
     (labels/types/sizes matching `pgbackrest info` on the host), and the
     PITR band with the archiver cross-check. A stored payload with
     `status.code != 0` renders as an honest error panel — that is correct
     behavior, not a page bug. The freshness badge must NOT show stale
     (>45 min) while the cron is healthy.
   - `/integrations/vault` lists secret metadata (or an honest empty list);
     a create → reveal (warn-confirm) → delete (typed-name confirm)
     round-trip works; then `select secret_name, actor, action from
     marketinghub.vault_console_audit order by id desc limit 5` shows the
     metadata rows — **values must appear nowhere**, including this audit.
   - `/admin/cloud` renders the static N/A panel (no fetch — by design).
3. CloudWatch: `Supabase/Backup:BackupStatusJobFailed` publishing 0s.

### 12.4 Rollback / failure posture

- **Reporter:** `rm -f /etc/cron.d/nsight-backup-status
  /usr/local/bin/backup-status-cron`. The console degrades to the staleness
  badge and then an aging-snapshot display; the table keeps its last row and
  is inert. NOTE (§11.4 lesson): a replacement host re-installs from the cdk
  assets — permanent rollback means reverting the Wave-7
  `cdk/assets`/`bootstrap.sh`/`compute-stack.ts` changes too.
- **Tables:** both are inert if unused — no app write path depends on them.
  `backup_status` may be truncated/dropped freely (page → honest empty
  state). Do NOT casually drop `vault_console_audit`: it is the only audit
  trail of console secret operations.
- **Vault console:** metadata-only by construction; turning it off is a code
  deploy (previous image), and the `vault` schema itself predates Wave 7 —
  no rollback here touches stored secrets.

### 12.5 Component-upgrade policy (standing)

The deployment is a PINNED COMBINATION, not a set of independently-updatable
parts. Source of truth: `SUPABASE_REF="v1.26.05"` in
`cdk/assets/bootstrap.sh`; that tag's `docker-compose.yml` fixes every
service image (studio `2026.04.27-sha-5f60601`, kong `3.9.1`, gotrue
`v2.186.0`, postgrest `v14.8`, realtime `v2.76.5`, storage-api `v1.48.26`,
postgres-meta `v0.96.3`, edge-runtime `v1.71.2`, logflare `1.36.1`,
supabase/postgres `15.8.1.085`, vector `0.53.0-alpine`, supavisor `2.7.4`).

1. **Never upgrade one container ad-hoc.** Upgrades move the whole bundle
   pin to a newer tag — one tested combination — through a preview stack
   first.
2. **Verify version-sensitive claims against the pinned images directly**
   (`docker run` the exact image, as the parity research does). The CLI's
   `supabase start` stack tracks the CLI release, not our pin, and is never
   evidence of behavior at v1.26.05.
3. **Postgres image bumps are restore-drill-grade events**: extension
   versions only change with the image; the data volume, WAL chain and
   pgBackRest stanza must stay coherent. Minors ride a maintenance window
   with a fresh full backup taken first; majors follow
   `docs/runbooks/upgrade-postgres-major.md`.
4. **On any pin bump, reconcile the derived artifacts:** re-vendor
   `cdk/assets/kong-nsight.yml` from the new tag's pristine kong.yml,
   re-applying ONLY our marked deltas (`# nsight-w6 analytics route`) — else
   the W6 pin-drift gate in `/tmp/enable-analytics-route.sh` will
   (correctly) refuse; re-run `scripts/gen-db-types.sh` and commit the
   regenerated `database.types.ts` (the drift-guard test enforces the hash);
   sanity-check the backup-status cron against the host's pgbackrest binary
   (JSON format 5 is stable since ~2.38; newer versions only add fields);
   update the feature catalog's pin/version facts.
5. **Host-side (non-bundle) components** — pgbackrest arrives via AL2023
   `dnf` and its binary version is not pinned by the repo (and currently
   UNVERIFIED); record it at the next host session/drill and prefer
   `dnf versionlock` if drift ever bites.
6. **Dev-tooling pins:** typegen/diff use `npx supabase@2.113.0`
   deliberately; bump it consciously and re-run typegen in the same change.

### 12.6 Vault root-key durability warning (standing, UNVERIFIED)

Vault plaintext depends on a ROOT KEY that lives OUTSIDE the database:
`vault.decrypted_secrets` decrypts with key material the GUC
`vault.getkey_script=/usr/lib/postgresql/bin/pgsodium_getkey.sh` materializes
inside the db container at boot. **pgBackRest and pg_dumpall capture only
ciphertext** — a restore onto a host without the same key material yields
undecryptable secrets, silently.

- **UNVERIFIED on our host** (no host access during Wave 7): where
  `pgsodium_getkey.sh` sources its key (data-dir file vs generated) and
  whether that location is inside the pgBackRest backup set and/or the EBS
  AWS Backup snapshot. Until verified, treat vault secrets as NOT durably
  restorable and keep authoritative copies of anything vault-stored in AWS
  (Secrets Manager/SSM) territory as well.
- **Next host session:** locate the key material, confirm backup coverage,
  and record the finding here.
- **Quarterly restore drill** (`docs/runbooks/restore-drill.md`) gains a
  vault-decrypt step: after the PITR restore, as postgres/supabase_admin run
  `select count(*) from vault.decrypted_secrets` and round-trip one known
  TEST secret — assert success/failure ONLY; never select secret values into
  a terminal log or drill notes. Fold this into the drill doc when the next
  drill is scheduled.

---

**Wave 3-partial (2026-08-08) — read-only GoTrue console views, deliberately no §13:** `/auth/users` and `/auth/providers` ship in the app image with ZERO operator actions — they ride Kong's always-enabled `auth-v1` route and the already-deployed `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env, carry no mutation affordances, and degrade to an honest "GoTrue unreachable" state on their own.
GoTrue login integration (the SAML cutover) is Wave 3's blocked remainder, pending the external SAML/IdP deliverable — nothing here to stage or apply until it lands.

---

## 13. Wave-8 Competitor-Intel Bedrock embeddings (2026-08-08)

Wave 8 ships the competitor-intel RAG module (`/intel`, schema
`competitor_intel`, `ci_embed` pgmq queue + worker consumer). **By default it
makes ZERO AWS calls**: `CI_EMBED_PROVIDER` defaults to `stub` — a
deterministic djb2 1024-dim provider — so preview search works end-to-end and
the UI badges "stub embeddings — similarity illustrative until Bedrock
enabled". The consumer is on by default but inert-safe (missing schema/queue
⇒ warn-once idle; a consumer error can never touch SMS dispatch — own module,
own interval, own error handling). Real Bedrock calls are a STAGED activation
behind the `enableBedrockEmbeddings` infra flag (default OFF; flag-absent
synth is byte-identical to Wave 7 — `app-infra/test/w8-bedrock.test.ts`
asserts both states).

### 13.1 Provider env vars

Read by `web/src/lib/intel/providers.ts` (`providerFromEnv()`) and the worker
consumer. Integer knobs are integer-guarded — never pass fractions (the §7
SMS 22P02 lesson):

| var | default | scope |
| --- | --- | --- |
| `CI_EMBED_PROVIDER` | `stub` (`stub` \| `bedrock`) | app + worker |
| `CI_EMBED_MODEL_ID` | `amazon.titan-embed-text-v2:0` | app + worker |
| `CI_EMBED_ENABLED` | `true` (worker consumer on/off) | worker |
| `CI_EMBED_POLL_INTERVAL_MS` | `30000` | worker |
| `CI_EMBED_BATCH` | `5` (messages per tick) | worker |
| `CI_EMBED_VT_S` | `120` (pgmq visibility timeout) | worker |
| `CI_EMBED_MAX_ATTEMPTS` | `3` (read_ct dead-letter cutoff) | worker |
| `CI_EMBED_DIMS` | `1024` (matches `vector(1024)`) | worker |

The flag-ON deploy sets ONLY `CI_EMBED_PROVIDER=bedrock` +
`CI_EMBED_MODEL_ID` on both containers; every other knob keeps its in-code
default. **NO new secret lands anywhere** — Bedrock auth is SigV4 via the
task role — and the worker task-def stays secret-frozen (§9.4).

### 13.2 What the flag changes (IAM surface)

`-c enableBedrockEmbeddings=true` adds, and nothing else:

- `~ AppTaskDef` / `~ WorkerTaskDef`: the two `CI_EMBED_*` env vars each
  (the app embeds search QUERIES in-request; the worker embeds document
  chunks off the queue);
- `+ 2` IAM policies — `bedrock:InvokeModel` on **exactly**
  `arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0`,
  one per TASK role (not the execution roles). These are the first task-role
  policies either service has ever had. The empty account field in the ARN is
  correct — foundation models are AWS-owned resources.

### 13.3 Activation

1. Apply the W8 migration first if not already live:
   `bash /tmp/apply-w8-intel.sh` (schema + queue + `ci_embed_sweep` cron +
   scoped rls-gate). Flag-ON with the schema absent is inert-safe (consumer
   warn-once idles, `/intel` shows NotProvisioned) — but activate in order.
2. Stage the PostgREST exposure if not already live:
   `bash /tmp/stage-w8-env.sh` — appends `competitor_intel` + `pgmq_public`
   to `PGRST_DB_SCHEMAS` (compose override + `.env` on the host, then
   recreates the `rest` container — a sub-second blip). Run AFTER step 1
   (reverse order is harmless — PostgREST just reloads again on the
   migration's `pg_notify`); independent of steps 3–4. Until it runs,
   `/intel` shows its honest NotProvisioned state (PGRST106) and the worker
   consumer warn-once idles. `pgmq_public` exposure is safe: functions only;
   `anon`/`authenticated` hold no schema USAGE, and the W8 migration revokes
   the Postgres-default `PUBLIC` EXECUTE that Wave 1 never removed, so
   EXECUTE really is `service_role`-exclusive — two independent denial
   layers. NEVER `grant usage on schema pgmq_public` to user roles
   (upstream's client-side-queues recipe): the wrappers run SECURITY DEFINER
   over EVERY pgmq queue in the database.
3. The LIVE images must already contain the Wave-8 build — the flag only sets
   env, it cannot ship code. If they predate Wave 8, do a normal image deploy
   (§2–4) first.
4. `bash /tmp/stage-w8-bedrock.sh` — derives ALL context from live state
   (incl. `workerImageTag` from the LIVE worker task-def, and the live W5
   realtime/app-config posture which it PRESERVES on the same deploy — a
   deploy omitting a live flag would strip that surface), runs the Bedrock +
   schema preflights, shows the `cdk diff`, requires typing
   `DEPLOY-W8-BEDROCK`, deploys. Expected diff = exactly §13.2; ANY new
   secret on the worker, env/secret removal, or different image = STOP.
5. Verify: both task-defs carry the two env vars; the
   `marketinghub-sms-worker` log stream shows consumer JSON tick lines with
   the bedrock provider and NO SMS dispatcher regression.
6. **Re-embed the stub-era corpus.** Chunks embedded before activation carry
   `embedding_model='stub-djb2-1024'`; `/intel/search` warns on corpus/query
   provider mismatch until they are re-embedded. On the Supabase host:

   ```bash
   docker exec supabase-db psql -U supabase_admin -d postgres \
     -c "update competitor_intel.documents set status='pending';"
   ```

   The `ci_embed_sweep` pg_cron job (`*/10` min) re-enqueues documents stuck
   `pending` >10 min, so the whole corpus re-embeds within ~20 min unattended
   (dupes harmless; processing is idempotent delete-then-insert). Spot-check:
   `select embedding_model, count(*) from competitor_intel.chunks group by 1;`

**Model-access gotcha:** if the first InvokeModel returns
`AccessDeniedException` mentioning model access, enable "Amazon / Titan Text
Embeddings V2" under Bedrock console → Model access in us-east-1 (one-time,
free) — IAM alone does not grant 1P model entitlement in older accounts.

### 13.4 Cost

Titan Text Embeddings V2 is ≈ **$0.02 per 1M input tokens** ($0.00002/1K),
on-demand, no provisioned throughput. Competitor-intel volumes (paste-text
docs plus one query embed per search) land in the **cents per month**; a full
1M-token corpus re-embed is ~2 cents. No budget action needed.

### 13.5 Networking / PrivateLink

Calls target `bedrock-runtime.us-east-1.amazonaws.com`. The tasks sit in the
Supabase VPC's PRIVATE_WITH_EGRESS subnets, so this rides the existing NAT
egress posture (same path as the SimpleTexting API). Optional hardening: an
interface endpoint for `com.amazonaws.us-east-1.bedrock-runtime` (private DNS
on = zero code changes; FIPS variant available) with an endpoint policy
restricted to `bedrock:InvokeModel` on the Titan ARN. The staged script
reports whether one exists — informational, not required.

### 13.6 Rollback = flag off

Rerun the same deploy with `-c enableBedrockEmbeddings=false` (the script
prints the exact command after deploy; the strict `===true/'true'` flag makes
`false` byte-identical to absent). The env reverts, `providerFromEnv()` falls
back to the stub (zero AWS calls), and both task-role policies are removed —
everything else (images, W5 posture) is preserved. Titan-embedded chunks KEEP
their `embedding_model` tag, so stub queries then show the honest
provider-mismatch warning; re-run the §13.3-step-6 UPDATE afterwards if you
want a stub-consistent corpus again. No data is lost in either direction.
