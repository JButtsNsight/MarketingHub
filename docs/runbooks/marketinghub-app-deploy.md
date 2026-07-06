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

- **Never** mark the `campaign-templates` bucket public.
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
