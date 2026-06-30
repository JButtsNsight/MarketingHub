# Self-Hosted Supabase on AWS — Design Spec

- **Created:** 2026-06-29 · **Revised:** 2026-06-30 (**v2, review-hardened**)
- **Status:** Draft for review (v2 supersedes v1; see §24 Revision history)
- **Target account:** `439024109088` (NSight / Socrates account), region `us-east-1`
- **Owner:** Justin (jbutts@nsightcare.com)
- **IaC:** AWS CDK (TypeScript)

> **v2 note:** v1 passed four independent Opus design reviews (AWS architecture, Supabase
> internals, security/HIPAA, ops/DR/cost). All four endorsed the core shape (reject Aurora,
> stay on the official compose bundle, private API + SSO'd Studio, KMS/private-subnet/7-yr
> baseline) but surfaced deploy-blockers and a HIPAA authorization gap. Every finding is
> carried as a concrete fix below; §23 maps finding → fix.

## 1. Goal

Stand up a production, HIPAA-aligned, **self-hosted full Supabase** stack in an isolated VPC
in the Socrates account, on Supabase's officially supported deployment path so it stays
patchable. Deliver the full developer experience — Postgres, REST/GraphQL APIs, Auth,
Realtime, Storage, Edge Functions, Studio, pgvector — with PHI never leaving our AWS BAA
boundary, **restorable backups, attributable audit trails, and authorization enforced at the
database (RLS)**.

## 2. Non-goals (v1)

- **No managed Aurora/RDS for the Supabase database** (§4 — it breaks the stack).
- **No public exposure of the data API.** Only Studio is public (SSO-gated, WAF'd).
- **No multi-AZ HA / automated failover.** Single-AZ node; recovery via auto-recovery +
  PITR restore (§9). HA is phase-2 (§19).
- **No Logflare/analytics log pipeline.** Logs → CloudWatch → S3/Glacier archive (§15).
- No data migration from any existing system. Greenfield instance.

> **In v1 (changed from v1 draft):** point-in-time recovery (PITR) via WAL archiving **is in
> scope** — it is the RPO fix and is independent of HA.

## 3. Approach decision

**Chosen: Approach A — single EC2 host running Supabase's official `docker-compose` bundle**,
with Postgres in the `supabase/postgres` container. Keeps us on the supported upgrade track and
gives full feature parity (all extensions/roles/migrations pre-baked). We own DB durability via
Postgres-native backup to S3 (§9).

**Upgrade nuance (corrected from v1):** "pull pinned image → recreate" is true for **minor/patch**
bumps only. **Major Postgres version** bumps (e.g. the June 2026 self-hosted PG15→17 move) change
the on-disk format and require a scripted `pg_upgrade` + maintenance window — see the runbook (§22).

**Rejected:** managed Aurora/RDS (locks down superuser + extension install → breaks Supabase);
ECS Fargate decomposition (diverges from upstream → fragile orchestration glue).

## 4. Why not Aurora (detail)

| Concern | Aurora/RDS | Supabase Postgres image (chosen) |
|---|---|---|
| Superuser / extension install | Locked down | Available |
| `pgsodium`, `Vault`, `pg_graphql`, `pg_net` | Unavailable / partial | Pre-baked |
| Roles + migration ordering | Manual, fragile | Shipped by Supabase |
| Minor upgrade | Re-validate by hand | Pull pinned image |
| Major PG upgrade | Managed | Scripted `pg_upgrade` (§22) |
| DB ops (backup/HA) | Managed | We own (PITR to S3, §9) |

## 5. Components (the compose stack)

Pin images **by digest** (not `latest`, not just a mutable tag) for reproducibility and supply-chain
integrity; mirror to **ECR** with scan-on-push and pull via the S3 gateway endpoint (avoids Docker
Hub rate limits during recovery). Services:

| Service | Role | v1 |
|---|---|---|
| `db` (`supabase/postgres`) | Postgres + all extensions; ships `wal_level=logical` | ✅ on dedicated encrypted EBS volume |
| `kong` | API gateway / single ingress, proxy `:8000` | ✅ (Admin API loopback-only, §11) |
| `auth` (GoTrue) | JWT auth, users | ✅ |
| `rest` (PostgREST) | Auto REST API | ✅ |
| `meta` (postgres-meta) | Schema introspection for Studio | ✅ |
| `realtime` | WebSocket subscriptions (logical replication) | ✅ |
| `storage` (storage-api) | File storage, **S3 backend** (§10) | ✅ |
| `imgproxy` | Image transforms (verify S3-source config) | ✅ |
| `functions` (edge-runtime, Deno) | Edge Functions (functions dir on persistent volume) | ✅ |
| `supavisor` | Connection pooler (`:5432` session / `:6543` txn) | ✅ |
| `studio` | Admin dashboard (talks to backend via Kong) | ✅ (SSO+WAF, §11) |
| `analytics` (Logflare) / `vector` | Log pipeline | ❌ **not enabled** (opt-in override; see below) |

**analytics/vector (corrected framing):** in the current bundle Logs/Analytics are an **opt-in
override** (`run.sh config add logs`), not on by default — so we simply **don't enable it**; no
hand-editing. On older pinned tags where `kong`/`studio` carry `depends_on: analytics`, those edges
must be removed or the front door hangs. Studio's Logs/Reports tabs are inert without it (accepted;
CloudWatch is the log source of truth, §15).

**Connection topology:** PostgREST/Auth/Storage/Realtime connect to `db` on the internal compose
network. External in-VPC SQL clients connect via **Supavisor** (`:5432` session, `:6543` txn).
Realtime uses a **direct/replication** connection (not transaction-pooled). SG rules expose only
the intended ports (§7).

## 6. Network design

- **Dedicated isolated VPC** in `439024109088`, `us-east-1`. Two AZs; **private app subnets in
  both AZs** (so a phase-2 standby/restore has a landing subnet in the surviving AZ).
- **Public subnets:** ALB only. **Private subnets:** EC2 host (no public IP).
- **Single managed NAT gateway**, pinned to the host's AZ. *Stated dependency:* the NAT is on the
  recovery path; to keep recovery and PHI off the public internet, add **VPC endpoints** (next).
- **VPC endpoints (v1):** **S3 gateway** (image layers via ECR, Storage backend, backups — also
  removes NAT data-processing cost), **interface endpoints** for Secrets Manager, KMS, CloudWatch
  Logs, ECR (api+dkr), SSM/SSM-Messages. PHI/secret/AWS-API traffic never traverses NAT/internet.
- VPC flow logs → CloudWatch, KMS-encrypted (short CW retention + S3 archive, §15).
- **Security groups (exact ports, no ranges):**
  - ALB-SG: `:443` from internet (WAF in front).
  - EC2-SG: **Studio port `:3000` from ALB-SG only**; **Kong proxy `:8000` from an internal-CIDR
    client SG only**; Supavisor `:5432`/`:6543` from internal-CIDR client SG only. **Kong Admin
    (`:8001`/`:8444`) and Kong Manager (`:8002`) are NOT in any SG rule** (loopback-only, §11).

## 7. Compute design

- **Single EC2 instance** (private subnet) — **no ASG.** Resilience via **EC2 auto-recovery**
  (CloudWatch alarm on `StatusCheckFailed_System` → recover, same instance, same EBS) plus a
  documented stop/start automation for instance-status failures. *(v1's ASG min=max=1 + standalone
  volume was a data-loss trap — an ASG replacement does not re-attach the data volume; removed.)*
- **Instance type:** **non-burstable, ≥16 GB** (start `m6i.xlarge`, 4 vCPU / 16 GB) — ~11 containers
  + Postgres + pgvector won't fit/perform on a burstable 8 GB box. Tune Postgres
  `shared_buffers`/`work_mem`; set Docker per-container memory limits.
- **Volumes:**
  - Root (≥50 GB gp3, KMS): OS/Docker. Enforce Docker log rotation (`max-size`/`max-file` or awslogs
    driver) + scheduled `docker image prune`. Alarmed on `/` full (§16).
  - **Dedicated gp3 data volume** (KMS), holding **the entire Postgres state** (`PGDATA` **and**
    `pg_wal` on the SAME volume — snapshot coherence invariant), Storage local cache/metadata, and
    the **edge-functions directory**. Mounted **by filesystem UUID in `/etc/fstab`** (Nitro renames
    `/dev/sdf`→`/dev/nvmeXn1`).
- **IMDSv2 required, `HttpPutResponseHopLimit=1`** (blocks container→IMDS SSRF). Host bootstrap runs
  on the host (reaches IMDS fine at hop-limit 1); containers that need AWS use dedicated scoped creds
  (§10/§13), never the instance role.
- **Bootstrap contract (fail-loud, idempotent):** install Docker → fetch secrets from Secrets Manager
  on the host (no echo, `set +x`, `chmod 600`, root-owned, not logged) → render compose env → mount
  data volume by UUID → **branch on a `.supabase-initialized` sentinel**: if present, attach & start
  **without** re-init; if the expected populated volume is **absent/empty**, **abort loudly** (do NOT
  silently initialize a fresh DB) → `docker compose up -d`. Re-runs converge against the persistent
  volume.

## 8. (reserved)

*(Section folded into §10.)*

## 9. Database backup & disaster recovery

**Primary: Postgres-native backup to S3 (not raw EBS snapshots).**
- **Continuous WAL archiving + periodic base backups via pgBackRest (or WAL-G)** to a dedicated
  KMS-encrypted S3 backup bucket → **PITR with minute-level RPO.** pgBackRest runs as a host process
  using the instance role (S3 backup bucket scoped).
- **Nightly `pg_dump`/`pg_dumpall`** to the same bucket (logical, portable, provably restorable, and
  the major-version migration tool — §22).
- **Secondary, fast-restore tier:** quiesced EBS snapshots via AWS Backup — pre/post hooks
  (`CHECKPOINT; pg_backup_start()` → `fsfreeze -f` → snapshot → `fsfreeze -u` → `pg_backup_stop()`)
  so they are application-consistent, not just crash-consistent. Enable **Fast Snapshot Restore** if
  snapshot restore stays on the RTO path (else document hydration latency).
- **Vault Lock (COMPLIANCE) in v1** (matches the Socrates backup standard); dedicated backup CMK;
  vault policy denies recovery-point deletion to the operational role. **Tiered retention:**
  daily→35 d, weekly→1 y, monthly→7 y (7-yr requirement is satisfied without hoarding 2,500+ dailies).

**Objectives (stated):** **RPO ≤ 5 min** (WAL archiving); **RTO target < 2 h** for full rebuild
(instance + restore + boot). v1 availability floor: **single-AZ, manual intervention for anything
beyond clean instance-status recovery** — accepted, documented for HIPAA contingency planning
(§164.308(a)(7)).

**Restore is a tested deliverable:** §17 acceptance includes an actual restore into a fresh
instance + row-count/schema/Storage round-trip validation + measured RTO; a **quarterly restore
drill** is scheduled. A recovery point that has never been restored is not a backup.

## 10. Storage backend (S3) + the container-credential rule

- Supabase Storage uses `STORAGE_BACKEND=s3` against a dedicated **KMS-encrypted, versioned,
  public-access-blocked** S3 bucket with **Object Lock (compliance) + lifecycle** aligned to the 7-yr
  window (so objects aren't hard-deleted out from under a DB restore).
- **Credential rule (resolves the IMDS hop-limit conflict):** containers run in a Docker bridge, and
  IMDSv2 hop-limit 1 (§7) intentionally blocks them from the instance role. So the **Storage container
  gets a dedicated, least-privilege IAM principal scoped to *only* this one bucket**, its credentials
  stored in Secrets Manager and injected only into the storage service. The **AWS key env vars are
  omitted entirely** for any service not using them (rendering them blank *overrides* the chain and
  breaks auth). Net effect: the only AWS credential reachable from inside a container is limited to a
  single bucket; Secrets Manager/KMS/instance-role stay unreachable from containers.
- **Dual-store consistency:** Storage bytes live in S3, metadata in Postgres. PITR (§9) + S3 Object
  Lock keep them recoverable; a **post-restore reconciliation job** flags metadata-without-object and
  object-without-metadata (the latter = ungoverned PHI in S3).
- Verify exact env-var names (`STORAGE_S3_BUCKET`/`REGION` vs `GLOBAL_S3_BUCKET`/`REGION`) and imgproxy
  S3-source config against the **pinned tag's `.env.example`** at build time; `STORAGE_S3_FORCE_PATH_STYLE=false`, omit `STORAGE_S3_ENDPOINT` for real S3.

## 11. Front door & auth

**Public ALB (HTTPS:443, ACM cert) + AWS WAF (v1)** — managed rule sets + rate limiting; ALB access
logging on; source-restricted to NSight egress ranges where feasible.

- **Studio path** → ALB `authenticate-cognito` → Cognito User Pool federated to the existing **NSight
  Google Workspace SAML** app → Studio (`:3000`). Hardening:
  - **Default listener action = `fixed-response 403`** (default-deny); every allowed path has an
    explicit authenticated rule covering **all** Studio routes (`/`, `/api/*`, assets, meta-proxy).
  - **Authorization, not just authentication:** restrict to a **named admin Google group → Cognito
    group → ALB rule condition** (authenticate-cognito alone lets in *anyone* in the pool). MFA enforced
    in Google Workspace.
  - Register every callback in the chain: ALB `/oauth2/idpresponse`, Cognito app-client callback
    (`https://<studio-host>/oauth2/idpresponse`), Cognito Hosted-UI domain, Google SAML ACS → Cognito.
  - Set ALB auth `SessionTimeout`; raise listener **idle timeout** above Realtime/Studio socket
    heartbeats; define a real health-check path. Studio basic-auth (`DASHBOARD_*`, strong ≥32-char,
    rotated on personnel change) sits underneath = defense in depth.
- **Kong Admin API (`:8001`/`:8444`) and Kong Manager (`:8002`) bound to `127.0.0.1` only** — never in
  any SG/ALB target. Verified unreachable in §17.
- **Data API kept private** (`/rest`,`/auth`,`/realtime`,`/storage`,`/functions`) via an **internal,
  TLS-terminating ALB** (or TLS on Kong) with an ACM **private CA** cert — so the PHI-bearing path is
  **encrypted in transit**, reached over a Route 53 private-hosted-zone record by in-VPC clients using
  Supabase JWTs. (v1's plaintext-in-VPC hop is fixed.) Public API exposure deferred (§19).

## 12. Authorization & PHI protection (the core HIPAA control)

- **Row-Level Security is mandatory and is a deploy gate.** Every table in every PHI-bearing schema:
  `ALTER TABLE … ENABLE ROW LEVEL SECURITY; … FORCE ROW LEVEL SECURITY;` with explicit **deny-by-default**
  policies *before any PHI is loaded*. `REVOKE` default privileges from `anon`/`authenticated`; grant
  explicitly per table so a forgotten policy fails closed.
  - **Gate/CI check:** query `pg_tables`/`pg_policies`; fail the release if any exposed-schema table has
    `rowsecurity=false` or zero policies (Studio's "Unrestricted" badge → must be zero).
  - **Acceptance (§17):** as `anon` and as a generic `authenticated` user, `SELECT` on each PHI table
    returns zero rows / permission denied.
- **`anon` key** is publicly-shippable and only an authenticator → RLS is the authorization. Apps
  integrate via the `anon`/**per-user JWT** path (minted by GoTrue) for per-subject authz + audit
  attribution.
- **`service_role` = crown jewel (BYPASSRLS).** Never distributed to application clients; trusted
  server-side/admin/migration use only; stored in a **separate Secrets Manager secret under a distinct
  KMS key/grant** from `anon`. §17 verifies no app config contains it.
- **JWT signing:** prefer **asymmetric (RS256/ES256)** signing keys so the data plane holds only the
  public verification key and a host compromise can't mint admin tokens. If HS256 is retained for v1,
  `JWT_SECRET` is a crown jewel (separate KMS, no app distribution); rotating it logs out all sessions
  (documented runbook, §13). *Note:* legacy `anon`/`service_role` JWT keys are being retired upstream
  (publishable/secret-key model) ~late 2026 — forward path tracked in §19.
- **Realtime authorization:** enable Realtime RLS/authorization so subscribers don't receive all row
  changes; broadcast/`postgres-changes` channels are policy-scoped.
- **`pg_net` lockdown:** it allows outbound HTTP *from inside the DB* (exfil/SSRF vector). `REVOKE
  EXECUTE` on its functions from `anon`/`authenticated`/`PUBLIC`; constrain NAT egress; disable the
  extension if unused in v1.

## 13. Secrets management

- **Complete required secret set** (v1's list was incomplete → boot failures). All in Secrets Manager
  (SSE-KMS), fetched on the host at boot:
  `POSTGRES_PASSWORD`, `JWT_SECRET` (or asymmetric key pair), `ANON_KEY`, `SERVICE_ROLE_KEY`,
  **`SECRET_KEY_BASE` (≥64)**, **`VAULT_ENC_KEY` (exactly 32)**, **`PG_META_CRYPTO_KEY`**,
  **`POOLER_TENANT_ID`**, **S3-protocol keys** (`S3_PROTOCOL_ACCESS_KEY_ID/SECRET`), `DASHBOARD_USERNAME`/
  `DASHBOARD_PASSWORD`, SES SMTP creds, and the **Storage bucket-scoped IAM creds** (§10). Validate
  lengths in bootstrap; cross-check the pinned tag's `.env.example`.
- **Handling:** IMDSv2-only; secrets never echoed/`set -x`; `.env` `chmod 600` root-owned (or injected
  without persisting); cloud-init secret step suppressed from logs; CloudWatch agent must not tail
  cloud-init logs. Docker socket root-only; host access via **SSM Session Manager only** (no SSH).
- **Least-privilege IAM:** instance role scoped to **exact ARNs** — Secrets Manager `GetSecretValue`
  on the specific secrets, KMS `Decrypt` on the specific keys, S3 backup bucket, CloudWatch Logs, SSM.
  No `*`. Storage uses its own bucket-scoped IAM user (§10), not the instance role.
- **Rotation runbooks (per secret class, not "re-run bootstrap"):** `JWT_SECRET`/keys → all-sessions
  invalidation, staged/asymmetric rollover; `POSTGRES_PASSWORD` → `ALTER ROLE` + env update coordinated;
  Storage/SES creds → Secrets Manager versioning. Document blast radius + cadence.

## 14. Encryption

- **At rest (KMS, customer-managed keys):** both EBS volumes, S3 (storage + backups), Secrets Manager,
  CloudWatch Logs, snapshots. **Key policies are segregated** — key admins ≠ usage principals; usage
  limited to the instance role + AWS Backup + CloudWatch Logs service principal via `kms:ViaService`/
  encryption-context conditions; deny otherwise. **No `kms:*`-to-root-only-without-conditions.**
- **S3 bucket policies:** `Deny` when `aws:SecureTransport=false`; require SSE-KMS with the specific CMK
  (`s3:x-amz-server-side-encryption` condition); account public-access-block on.
- **In transit:** TLS at the public ALB (Studio) **and** the internal ALB/Kong (data API) — so the
  primary PHI path is encrypted, not just the edge (§11). Realtime over `wss`.

## 15. Audit & logging (HIPAA §164.312(b))

- **`pgaudit`** capturing DML on PHI tables with acting role/user → shipped to logs; combined with
  per-user JWTs (§12) so PHI reads/writes are **attributable to a principal** (service_role access is
  otherwise anonymous). Acceptance asserts attribution.
- **CloudTrail data events** for the PHI S3 buckets + KMS usage; control-plane CloudTrail inherited.
- **Log tiering (fixes the cost bomb + retention):** short **CloudWatch retention (30–90 d)** for
  operability → **export to S3 + Glacier with Object Lock for the 7-yr compliance tier** (~10× cheaper
  than 7-yr CloudWatch). Flow logs follow the same tiering.
- **No PHI in logs — enforced, not asserted:** structured logging with explicit field allowlists; verify
  PostgREST/Kong request logging does not capture PHI query strings/bodies into the long-term store.

## 16. Observability & alerting (single-node safety net)

CloudWatch **agent pushes host + container metrics**; an **SNS topic → on-call** receives:
- EBS **data-volume** and **root-volume** `disk_used_percent` ≥ 80%.
- **Container down / unhealthy** (compose healthchecks → metric; ASG-style instance health is blind to
  a dead `db` container on a live host).
- **Postgres reachability** (synthetic check), **connection saturation**.
- **`pg_replication_slots` retained-WAL / slot lag** (a stuck Realtime slot fills the disk — known
  footgun).
- **AWS Backup / pgBackRest job FAILED** (EventBridge → SNS) — silent backup failure is otherwise invisible.
- **EC2 auto-recovery / stop-start events**, **CPU credit** (if any burstable fallback).
- **AWS Budget alarm** on the account/stack tag.

Delivered as an **`ObservabilityStack`** in CDK.

## 17. Verification / acceptance

Functional: from an in-VPC client — REST insert/select, Auth signup/login (JWT), a Realtime subscription
receiving a change, **Storage upload landing in S3 using only the bucket-scoped cred**, an Edge Function
invocation, and a `pgvector` query all succeed. All containers reach healthy with analytics/vector absent
(no hung kong/studio). Stack boots with the **complete** secret set.

Security/HIPAA: `anon` and generic `authenticated` reads on every PHI table return **zero rows / denied**
(RLS gate); **no app config contains `service_role`**; unauthenticated requests to Studio root **and**
sub-paths/api/asset paths return **401/403**; Kong Admin port **unreachable** from in-VPC; PHI read/write
is **attributable** in `pgaudit`.

Durability/DR: **terminate (not reboot)** the instance and confirm data survives via auto-recovery/volume
retention **and** that the bootstrap refuses to re-init when the volume is populated; **restore the latest
PITR/backup into a fresh instance**, start Postgres, confirm clean WAL replay, validate row counts/schema +
a Storage object round-trip, **record measured RTO**; Realtime stays connected past the ALB idle timeout.
Backup-failure alarm fires on an induced failure.

## 18. Security controls → HIPAA mapping (summary)

| Control | Where | HIPAA |
|---|---|---|
| Access control (RLS, least-priv IAM, SGs) | §12, §13, §6 | §164.312(a) |
| Audit controls (pgaudit, CloudTrail, attribution) | §15 | §164.312(b) |
| Integrity (PITR, restore drills, Object Lock) | §9, §10 | §164.312(c) |
| Person/entity auth (Cognito+Google SAML+MFA, JWT) | §11, §12 | §164.312(d) |
| Transmission security (TLS edge + in-VPC) | §14 | §164.312(e) |
| Contingency plan (RPO/RTO, backups, Vault Lock) | §9 | §164.308(a)(7) |
| Encryption at rest (KMS, segregated policies) | §14 | §164.312(a)(2)(iv) |

## 19. v1 trade-offs & explicit deferrals

- **DB HA / multi-AZ failover:** deferred. v1 = single-AZ + auto-recovery + PITR restore (RTO < 2 h).
  Phase-2: streaming-replication standby (or Patroni) in the second AZ.
- **Public data API:** internal-only in v1; phase-2 adds a public front door with its own WAF/rate-limit.
- **Studio exposure:** public + SSO + WAF + admin-group in v1 (per owner decision); phase-2 tighten to
  private (VPN/SSM/Cloudflare Access).
- **JWT key model:** legacy `anon`/`service_role` acceptable for v1; migrate to publishable/secret keys
  before the upstream sunset (~late 2026).
- **Logflare/analytics:** not enabled; CloudWatch is the log source of truth.

## 20. Open items to confirm before deploy

1. **SES production access** in `us-east-1` (a brand-new identity is sandboxed → Auth emails silently
   won't deliver). **Pre-deploy blocker**, not just an open item; DKIM/SPF set, no PHI in mail bodies.
2. **DNS provider** for `nsightcare.com` (Route 53 vs Cloudflare) + exact Studio hostname + ACM cert.
3. **Cognito ↔ Google SAML** callback enumeration (§11) and the **admin Google group** to gate Studio.

## 21. IaC structure (CDK, TypeScript)

Stacks (us-east-1), dependency-safe ordering:
- **`FoundationStack`** — **KMS keys** (segregated policies) + shared config, consumed by all others
  (prevents the encryption-key dependency-order reversal).
- **`NetworkStack`** — VPC, 2-AZ subnets, NAT, **VPC endpoints**, flow logs, SGs.
- **`DataStack`** — S3 storage + backup buckets (Object Lock), Secrets Manager secrets, AWS Backup vault
  (Vault Lock) + plan.
- **`ComputeStack`** — EC2 launch template (IMDSv2 hop-limit 1), instance role (**exact-ARN scoped**),
  EBS data volume, auto-recovery alarm, user-data bootstrap. **Bucket access granted via the role's IAM
  policy referencing the bucket ARN — NOT a bucket resource policy naming the role** (breaks the v1
  circular dependency). Cross-stack via object references (CDK-managed), not manual exports; don't export
  the instance/target directly.
- **`EdgeStack`** — public ALB + WAF + ACM + Cognito user pool + Google SAML IdP + listener rules
  (default-deny) + Route 53; internal data-API ALB + private cert.
- **`ObservabilityStack`** — alarms, SNS on-call, Budget.

## 22. Upgrade & patching runbook

- **Minor/patch image bumps:** snapshot first → `docker compose pull` (pinned digests) → `up -d` → verify.
  Single target = brief Studio 5xx during recreate → **planned maintenance window**; tune health-check +
  `deregistration_delay` so the recreate isn't killed; rollback = re-pin previous digests.
- **Major Postgres version (e.g. 15→17):** **mandatory verified backup first** (§9) → drop active
  replication slots → scripted `pg_upgrade` (or `pg_dump`/restore) into a new data dir, reconcile extension
  versions + UID ownership, keep old data dir as rollback → planned downtime. Pin to a **PG17** tag from
  day one to avoid an immediate forced migration. Check for dropped extensions (e.g. timescaledb/plv8) before upgrading.
- **OS/Docker patching:** maintenance window (no HA in v1); blue/green host where feasible in phase-2.

## 23. Review remediation traceability

| # | Finding (v1) | Severity | Fixed in |
|---|---|---|---|
| 1 | ASG+standalone EBS doesn't re-attach → data loss | 🔴 | §7 (single instance + auto-recovery + UUID mount + sentinel) |
| 2 | Crash-consistent backups, 24 h RPO | 🔴 | §9 (pgBackRest WAL/PITR + pg_dump + quiesced snapshots) |
| 3 | RLS absent — only PHI control | 🔴 | §12 (RLS mandate + gate + acceptance) |
| 4 | Incomplete secret set → won't boot | 🔴 | §13 (full list incl. SECRET_KEY_BASE/VAULT_ENC_KEY/…) |
| 5 | service_role / JWT_SECRET crown jewels | 🔴 | §12, §13 (segregation, asymmetric signing, no app distribution) |
| 6 | Major PG upgrade ≠ image pull | 🟠 | §3, §22 (pg_upgrade runbook, pin PG17) |
| 7 | No TLS on in-VPC API path | 🟠 | §11, §14 (internal TLS ALB / Kong TLS) |
| 8 | Kong Admin API exposure | 🟠 | §6, §11 (loopback-only, exact ports, §17 check) |
| 9 | No RTO/RPO; implicit single-AZ | 🟠 | §9 (RPO ≤5 min, RTO <2 h, stated floor) |
| 10 | No alarms / observability | 🟠 | §16 (ObservabilityStack + SNS) |
| 11 | ALB Cognito authz + bypass | 🟠 | §11 (default-deny, all paths, admin group, callbacks) |
| 12 | IMDSv2 + secret handling | 🟠 | §7, §13 (hop-limit 1, no-echo, exact-ARN IAM) |
| 13 | HIPAA audit trail missing | 🟠 | §15 (pgaudit + CloudTrail data events + attribution) |
| 14 | DR test = reboot, not restore | 🟠 | §9, §17 (real restore + quarterly drill) |
| 15 | Storage dual-store consistency | 🟠 | §10 (Object Lock + reconciliation) |
| 16 | Instance undersized / burstable | 🟡 | §7 (m6i.xlarge, 16 GB, non-burstable) |
| 17 | VPC endpoints (NAT dep + cost + PHI) | 🟡 | §6 (S3 gateway + interface endpoints) |
| 18 | Root vol SPOF / log rotation | 🟡 | §7 (size, rotation, prune, alarm) |
| 19 | analytics/vector framing + depends_on hang | 🟡 | §5 (opt-in; remove depends_on on old tags) |
| 20 | CDK circular dep / KMS ordering | 🟡 | §21 (FoundationStack KMS; role-IAM grant) |
| 21 | Supavisor topology / ports | 🟡 | §5, §6 |
| 22 | imgproxy/functions volumes; Studio↔Kong | 🟡 | §5, §7, §11 |
| 23 | pg_net SSRF/exfil | 🟡 | §12 (revoke EXECUTE, egress, disable if unused) |
| 24 | Vault Lock deferred / retention | 🟡 | §9 (Vault Lock v1 + tiered retention) |
| 25 | CloudWatch 7-yr cost / wrong tier | 🟡 | §15 (short CW + S3/Glacier archive) |
| 26 | Cost underestimate | 🟡 | §25 (~$350–550/mo + Budget alarm) |
| 27 | KMS policy / S3 TLS-only | 🟡 | §14 (segregated policies, SecureTransport deny) |
| 28 | WAF only phase-2 | 🟡 | §11 (WAF on public ALB in v1) |
| 29 | SES sandbox | 🟡 | §20 (pre-deploy blocker) |
| 30 | Legacy JWT keys sunset | ⚪ | §12, §19 (migration tracked) |
| 31 | Image digest pinning / scanning | ⚪ | §5 (digest pin + ECR scan-on-push) |

## 24. Revision history

- **v1 (2026-06-29):** initial design. Committed `0ed1130`.
- **v2 (2026-06-30):** review-hardened after four Opus design reviews. Replaced ASG with single
  instance + auto-recovery; added PITR/pgBackRest + tested restore; mandated RLS + crown-jewel key
  handling; completed the secret set; added internal TLS, Kong-admin lockdown, WAF, pgaudit/CloudTrail,
  ObservabilityStack, VPC endpoints, Vault Lock, log tiering; resized compute; fixed CDK dependency
  structure; added upgrade runbook and cost re-estimate. Traceability in §23.

## 25. Cost estimate (revised)

Realistic steady-state, us-east-1, 24/7: **~$350–550/mo**, dominated by NAT + logs (not compute).
Largest levers — already adopted — are the **S3 gateway endpoint** (kills NAT data-processing) and
**short CloudWatch + S3/Glacier archive** (kills the log bomb). EC2 (`m6i.xlarge`) ~ $140/mo on-demand
(less if covered by account Savings Plans); NAT ~$35–60; ALB(s) ~$20–35; EBS + snapshots ~$30–50; S3 +
backups ~$10–30; Secrets/KMS ~$5; logs (tiered) ~$15–40. A **Budget alarm** (§16) tracks drift.
