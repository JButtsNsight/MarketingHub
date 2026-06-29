# Self-Hosted Supabase on AWS — Design Spec

- **Date:** 2026-06-29
- **Status:** Draft for review
- **Target account:** `439024109088` (NSight / Socrates account), region `us-east-1`
- **Owner:** Justin (jbutts@nsightcare.com)
- **IaC:** AWS CDK (TypeScript)

## 1. Goal

Stand up a production, HIPAA-aligned, **self-hosted full Supabase** stack in an isolated
VPC in the Socrates account, using Supabase's officially supported deployment path so it
stays patchable over time. Deliver the full developer experience — Postgres, auto REST/GraphQL
APIs, Auth, Realtime, Storage, Edge Functions, Studio, and pgvector — with PHI never leaving
our AWS BAA boundary.

## 2. Non-goals (v1)

- **No managed Aurora/RDS for the Supabase database.** (See §4 — it breaks the stack.)
- **No public exposure of the data API.** Only Studio is public (SSO-gated) in v1.
- **No database high-availability / multi-AZ failover in v1.** Single-node DB with
  snapshot-based recovery; HA is an explicit phase-2 (§14).
- **No Logflare/analytics log pipeline in v1.** Logs go to CloudWatch instead.
- No data migration from any existing system. Greenfield instance.

## 3. Approach decision

**Chosen: Approach A — EC2 host running Supabase's official `docker-compose` bundle.**

Supabase ships and tests its stack as a single compose bundle against its own
`supabase/postgres` image, which has all required extensions, roles, and migrations
pre-baked. Running that bundle on an EC2 host keeps us on the supported upgrade track
(pull pinned images → recreate) and gives **full feature parity**. We own database
durability via encrypted EBS + AWS Backup snapshots.

**Rejected: managed Aurora/RDS for the DB.** Self-hosted Supabase assumes an unrestricted
Postgres (superuser + `pgsodium`/`Vault`/`pg_graphql`/`pg_net` + migration ordering).
Managed RDS/Aurora lock down superuser and extension installation, which is precisely what
breaks Supabase — documented as multi-week fragile custom work that re-breaks on every
Supabase image bump. Not acceptable under HIPAA.

**Rejected: decompose into ECS Fargate (one service per container).** Diverges from
upstream, so we own orchestration glue that goes stale across Supabase's frequent releases —
the same fragility, relocated.

## 4. Why not Aurora (detail)

| Concern | Aurora/RDS | Supabase Postgres image (chosen) |
|---|---|---|
| Superuser / extension install | Locked down | Available |
| `pgsodium`, `Vault`, `pg_graphql`, `pg_net` | Unavailable / partial | Pre-baked |
| Roles + migration ordering | Manual, fragile | Shipped by Supabase |
| Upgrade story | Re-validate by hand each release | Pull pinned image |
| DB ops (backup/HA) | Managed | We own (EBS + AWS Backup) |

We trade managed DB ops for feature parity + maintainability, and recover durability with
AWS-native backup tooling.

## 5. Components (the compose stack)

Pin to a specific Supabase release tag (not `latest`) for reproducibility. Services:

| Service | Role | v1 |
|---|---|---|
| `db` (`supabase/postgres`) | Postgres + all extensions | ✅ on dedicated encrypted EBS volume |
| `kong` | API gateway / single ingress (`:8000`) | ✅ |
| `auth` (GoTrue) | JWT auth, users | ✅ |
| `rest` (PostgREST) | Auto REST API | ✅ |
| `meta` (postgres-meta) | Schema introspection for Studio | ✅ |
| `realtime` | WebSocket subscriptions (logical replication) | ✅ |
| `storage` (storage-api) | File storage, **S3 backend** | ✅ |
| `imgproxy` | Image transforms for Storage | ✅ |
| `functions` (edge-runtime, Deno) | Edge Functions | ✅ |
| `supavisor` | Connection pooler | ✅ |
| `studio` | Admin dashboard | ✅ (SSO-gated) |
| `analytics` (Logflare) | Log pipeline | ❌ disabled v1 |
| `vector` | Log shipping to Logflare | ❌ disabled v1 |

GraphQL (`pg_graphql`) works here because we are **not** on Aurora.

## 6. Network design

- **Dedicated VPC** in `439024109088`, `us-east-1`, isolated from other workloads.
- 2 Availability Zones (ALB requires ≥2 subnets).
- **Public subnets:** ALB only.
- **Private subnets:** EC2 host (no public IP).
- **Single managed NAT gateway** for egress (image pulls, Cognito, SES).
- VPC flow logs → CloudWatch (encrypted, 7-yr).
- Security groups: ALB SG (443 from internet) → EC2 SG (Studio/Kong ports from ALB SG only);
  internal API access from a VPC-internal CIDR allowlist SG.

## 7. Compute design

- **EC2** in an ASG (min=max=desired=1) in a private subnet, for auto-replacement on failure;
  EC2 auto-recovery enabled.
- Instance type: start `t3.large` (2 vCPU / 8 GB); revisit under load.
- **Two volumes:** root (OS/Docker, encrypted), and a **dedicated encrypted gp3 EBS data
  volume** mounted for the Postgres data directory + storage metadata. Backups target the
  data volume.
- **Bootstrap (user-data):** install Docker + compose plugin → fetch secrets from Secrets
  Manager → render `.env` → fetch pinned Supabase compose bundle → `docker compose up -d`.
  Idempotent so ASG replacement re-converges against the persistent EBS data volume.

## 8. Storage backend (S3)

- Supabase Storage configured with `STORAGE_BACKEND=s3` against a dedicated **encrypted S3
  bucket** (SSE-KMS, versioned, public access blocked).
- Credentials via the **EC2 instance role** (default provider chain) — no static S3 keys.
- Bucket policy restricts access to the instance role.

## 9. Front door & auth

**Public ALB (HTTPS:443, ACM cert), Socrates-style:**

- **Studio path** → ALB `authenticate-cognito` action → Cognito User Pool federated to the
  existing **NSight Google Workspace SAML** app (idpid `C00n27oyt`, reused per the NSight SSO
  standard) → Studio target. Studio's own dashboard basic-auth sits underneath = defense in
  depth.
- **Data API** (`/rest`, `/auth`, `/realtime`, `/storage`, `/functions`) → **NOT** behind
  Cognito (machine clients can't do interactive SAML). Reached **privately** within the VPC
  via an internal Route 53 private-hosted-zone record → EC2 → Kong (`:8000`), SG-restricted
  to internal CIDRs. Authenticated by Supabase's own JWT keys (anon / service-role / user JWT).
  Public API exposure is deferred (§14).

**DNS:** Studio hostname under `nsightcare.com` (e.g. `supabase.nsightcare.com`), ACM cert in
`us-east-1`. *DNS provider for nsightcare.com (Route 53 vs Cloudflare) to confirm at deploy —
see §15.*

## 10. Secrets management

All in Secrets Manager (SSE-KMS), pulled at boot via instance role; nothing hardcoded:
`POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_USERNAME`,
`DASHBOARD_PASSWORD`, SMTP credentials (SES). Keys rotated by re-running bootstrap.

## 11. Data flow

1. **Human → Studio:** browser → ALB(443) → Cognito/Google SAML login → Studio → `meta`/`db`.
2. **Internal app → API:** app (in-VPC) → private DNS → Kong(`:8000`) → `rest`/`auth`/
   `realtime`/`storage`, authenticated by Supabase JWT.
3. **Storage:** `storage-api` ↔ S3 (instance-role creds); metadata in Postgres.
4. **Realtime:** Postgres logical replication → `realtime` → WebSocket subscribers in-VPC.

## 12. Durability, backup & logging

- **KMS encryption** on EBS (both volumes), S3, Secrets Manager, CloudWatch logs.
- **AWS Backup** on the EBS data volume: daily, 7-yr retention (HIPAA). Vault Lock
  considered post-v1.
- **CloudWatch:** container logs via CloudWatch agent/log driver, 7-yr retention; VPC flow logs.
- TLS terminated at ALB; in-VPC traffic stays within the private network.

## 13. Security / HIPAA controls

- Private subnets; no public IP on the host; least-privilege instance role + SGs.
- Encryption at rest (KMS) and in transit (TLS at edge).
- 7-yr retention on all logs/audit; GuardDuty + Security Hub inherited from the account.
- No PHI in logs. Resource tagging per the NSight 5-tag standard.

## 14. v1 trade-offs & explicit deferrals

- **DB HA:** single-AZ; recovery = restore EBS snapshot + ASG re-converge. Phase-2: split DB
  to its own host with streaming replication / standby (or Patroni).
- **Public API:** internal-only in v1; phase-2 adds a public API front door (e.g. dedicated
  ALB path or Cloudflare) with its own rate-limiting/WAF.
- **Logflare/analytics:** disabled; Studio Logs tab limited; CloudWatch is source of truth.
- **Auth upgrade path:** Cognito/SAML front door now; can tighten to Cloudflare Access /
  private-only later.

## 15. Open items to confirm before deploy

1. **DNS provider** for `nsightcare.com` (Route 53 vs Cloudflare) and the exact Studio hostname.
2. **Cognito ↔ Google SAML** reuse confirmed against the existing NSight SAML app (callback URL
   add for the new Cognito domain).
3. **SES** availability/identity in `us-east-1` for GoTrue auth emails (or alternative SMTP).

## 16. IaC structure (CDK, TypeScript)

Stacks (us-east-1):
- `NetworkStack` — VPC, subnets, NAT, flow logs, SGs.
- `DataStack` — S3 storage bucket, KMS keys, Secrets Manager secrets, AWS Backup vault/plan.
- `ComputeStack` — EC2 launch template + ASG, instance role, EBS data volume, user-data bootstrap.
- `EdgeStack` — ALB, ACM cert, Cognito user pool + Google SAML IdP, listener rules, Route 53 records.

## 17. Verification (acceptance)

- Studio reachable only via the SSO-gated hostname; unauthenticated access blocked.
- From an in-VPC client: REST insert/select, Auth signup/login (JWT), a Realtime subscription
  receiving a change, a Storage upload landing in S3, an Edge Function invocation, and a
  `pgvector` query all succeed.
- Reboot/replace the EC2 instance → stack re-converges against the persistent EBS volume with
  no data loss.
- AWS Backup recovery point present; logs flowing to CloudWatch at 7-yr retention.
