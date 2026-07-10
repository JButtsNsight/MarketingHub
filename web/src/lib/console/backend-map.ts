/**
 * Architecture reference for the MarketingHub self-hosted Supabase-on-AWS stack.
 *
 * This is a hand-maintained, typed mirror of what the CDK (cdk/ + app-infra/)
 * and cdk/sql/ actually provision. It is REFERENCE data derived from the
 * infrastructure-as-code — NOT live telemetry. The web container reaches the
 * backend only through the private data API (service-role PostgREST + Storage),
 * so it cannot read CloudWatch, backup jobs, Cognito user lists, or per-service
 * health. Surfaces that render this map must label it as reference, never imply
 * real-time status (see REFERENCE_DISCLAIMER). Keep it in sync with the IaC.
 */

export const REFERENCE_DISCLAIMER =
  "Architecture reference, sourced from infrastructure-as-code (CDK + SQL) — not live telemetry. The console reaches the backend only through the private service-role data API.";

export interface ProjectMeta {
  name: string;
  account: string;
  region: string;
  host: string;
  bundle: string;
  postgres: string;
  vpcCidr: string;
}

export const PROJECT: ProjectMeta = {
  name: "MarketingHub",
  account: "439024109088",
  region: "us-east-1",
  host: "single m6i.xlarge (AL2023, Nitro)",
  bundle: "supabase/supabase v1.26.05",
  postgres: "PostgreSQL 17 (Supabase-patched)",
  vpcCidr: "10.60.0.0/16",
};

export interface ServiceInfo {
  name: string;
  role: string;
  port: string;
  exposure: string;
}

/** The Supabase stack containers (docker-compose on the single host). */
export const SERVICES: ServiceInfo[] = [
  { name: "db", role: "PostgreSQL 17 — PGDATA + WAL on the encrypted EBS data volume", port: "5432", exposure: "internal" },
  { name: "kong", role: "API gateway — the single data-plane ingress", port: "8000", exposure: "internal data-API ALB → Kong" },
  { name: "auth (GoTrue)", role: "JWT auth / user management (SES SMTP for auth email)", port: "9999", exposure: "via Kong" },
  { name: "rest (PostgREST)", role: "Auto REST API over exposed schemas", port: "3000", exposure: "via Kong" },
  { name: "meta (postgres-meta)", role: "Schema introspection backing Studio", port: "8080", exposure: "via Kong" },
  { name: "realtime", role: "WebSocket subscriptions over logical replication", port: "4000", exposure: "via Kong" },
  { name: "storage (storage-api)", role: "File storage, STORAGE_BACKEND=s3 (bucket-scoped IAM)", port: "5000", exposure: "via Kong" },
  { name: "imgproxy", role: "Image transforms (S3 source)", port: "5001", exposure: "internal" },
  { name: "functions (edge-runtime)", role: "Deno Edge Functions on the persistent volume", port: "9000", exposure: "via Kong" },
  { name: "supavisor", role: "Connection pooler (session / transaction)", port: "5432 / 6543", exposure: "internal" },
  { name: "studio", role: "Supabase admin dashboard (separate public ALB)", port: "3000", exposure: "public ALB + Cognito (supabase-admins)" },
];

export const NOT_ENABLED =
  "analytics (Logflare) + the vector log pipeline are NOT enabled — logs go to CloudWatch → S3/Glacier instead, so Studio's Logs/Reports tabs are inert (accepted).";

export const EXPOSED_SCHEMAS = [
  "public",
  "storage",
  "graphql_public",
  "marketinghub",
] as const;

export const EXTENSIONS = [
  "pgcrypto",
  "pgaudit",
  "pg_net (locked down)",
  "pgvector",
  "pg_graphql",
] as const;

export interface BucketInfo {
  name: string;
  kind: "supabase" | "s3-backend";
  privacy: string;
  note: string;
}

export const BUCKETS: BucketInfo[] = [
  {
    name: "campaign-templates",
    kind: "supabase",
    privacy: "private (public=false)",
    note: "Raw template files (text/html/eml) under <template-id>/<safe-filename>. Served only via short-lived (5-min) service-role signed URLs.",
  },
  {
    name: "StorageBucket (S3)",
    kind: "s3-backend",
    privacy: "block-public-access ALL",
    note: "SSE-KMS backend for Supabase Storage. Versioned, Object Lock COMPLIANCE 2555d, enforceSSL; noncurrent → Glacier @30d.",
  },
  {
    name: "BackupBucket (S3)",
    kind: "s3-backend",
    privacy: "block-public-access ALL",
    note: "pgBackRest WAL/base backups + nightly pg_dump. SSE-KMS, Object Lock COMPLIANCE 2555d, Glacier @30d.",
  },
  {
    name: "LogArchiveBucket (S3)",
    kind: "s3-backend",
    privacy: "block-public-access ALL",
    note: "7-year Object Lock Glacier archive of CloudWatch logs via Firehose.",
  },
  {
    name: "PhiDataTrailBucket (S3)",
    kind: "s3-backend",
    privacy: "block-public-access ALL",
    note: "CloudTrail S3 object-level data events on the storage + backup buckets.",
  },
];

export interface CognitoModel {
  idp: string;
  pools: { name: string; purpose: string; group: string }[];
  groups: { name: string; grants: string }[];
  session: string;
}

export const COGNITO: CognitoModel = {
  idp: "AWS Cognito federated to the NSight Google Workspace SAML app (idpid C00n27oyt); self-signup disabled (federated-only).",
  pools: [
    { name: "nsight-marketinghub", purpose: "The marketing web app front door", group: "marketing / marketinghub-admins" },
    { name: "nsight-supabase-studio", purpose: "Supabase Studio front door", group: "supabase-admins" },
  ],
  groups: [
    { name: "marketing", grants: "View + create campaign templates (the app's base gate)" },
    { name: "marketinghub-admins", grants: "Elevated MarketingHub administration" },
    { name: "supabase-admins", grants: "Access to Supabase Studio (separate ALB/pool)" },
  ],
  session: "12h ALB session, WAFv2 in front; the ALB injects a verified x-amzn-oidc-data (ES256) token per request.",
};

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  note?: string;
}

export interface PolicyInfo {
  name: string;
  command: string;
  roles: string;
  kind: "PERMISSIVE" | "RESTRICTIVE";
  using: string;
  check: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  purpose: string;
  columns: ColumnInfo[];
  rls: string;
  policies: PolicyInfo[];
}

/** The one application table, exactly as cdk/sql/2026-07-05-templates.sql defines it. */
export const TEMPLATES_TABLE: TableInfo = {
  schema: "marketinghub",
  name: "templates",
  purpose:
    "Campaign-template metadata (text/email). The only app-created table. Raw files live in the campaign-templates bucket; this row holds metadata + a generated full-text search vector.",
  columns: [
    { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()", note: "primary key" },
    { name: "name", type: "text", nullable: false },
    { name: "type", type: "text", nullable: false, note: "CHECK type IN ('text','email')" },
    { name: "category", type: "text", nullable: false, note: "plain text (no enum)" },
    { name: "tags", type: "text[]", nullable: false, default: "'{}'" },
    { name: "subject", type: "text", nullable: true, note: "required for email type (app-enforced)" },
    { name: "body", type: "text", nullable: false },
    { name: "storage_path", type: "text", nullable: true, note: "<id>/<safe-filename> in campaign-templates" },
    { name: "created_by", type: "text", nullable: false, note: "authed user email" },
    { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    { name: "updated_at", type: "timestamptz", nullable: false, default: "now()" },
    { name: "search", type: "tsvector", nullable: true, note: "GENERATED ALWAYS from name/tags/category/body (english)" },
  ],
  rls: "ENABLE + FORCE ROW LEVEL SECURITY — deny-by-default. service_role (BYPASSRLS) is the only accessor; the app-layer Cognito 'marketing' gate is the real boundary.",
  policies: [
    {
      name: "templates_deny_all",
      command: "ALL",
      roles: "anon, authenticated",
      kind: "RESTRICTIVE",
      using: "false",
      check: "false",
    },
  ],
};

/** Stock Supabase schemas present but not defined in this repo's SQL. */
export const STOCK_SCHEMAS = [
  { name: "auth", note: "GoTrue users/sessions/identities. Present, but the app uses Cognito, not GoTrue login." },
  { name: "storage", note: "storage.buckets + storage.objects (metadata; bytes in S3)." },
  { name: "realtime", note: "Realtime subscriptions / replication." },
  { name: "net", note: "pg_net outbound HTTP — EXECUTE revoked from anon/authenticated/PUBLIC (SSRF lockdown)." },
] as const;

export interface RefItem {
  label: string;
  detail: string;
  status?: "ok" | "warn" | "info";
}

export const SECURITY_POSTURE: RefItem[] = [
  { label: "Data API isolation", detail: "Private internal ALB → Kong, TLS via ACM Private CA. Only Studio + the marketing app are public (both Cognito/SAML + WAF).", status: "ok" },
  { label: "RLS deploy gate", detail: "rls-gate.sql blocks release if any exposed table (public/storage/auth/realtime/marketinghub) has RLS off or zero policies.", status: "ok" },
  { label: "service_role secrecy", detail: "service_role JWT delivered via Secrets Manager (own CMK, kms:ViaService=secretsmanager only); never in the image, env plaintext, or browser.", status: "ok" },
  { label: "pg_net lockdown", detail: "EXECUTE on net.http_* revoked from PUBLIC/anon/authenticated (blanket + per-function + default privileges).", status: "ok" },
  { label: "Kong admin surface", detail: "Kong Admin :8001/:8444 and Manager :8002 bind loopback-only — never in any security group or ALB.", status: "ok" },
  { label: "At-rest encryption", detail: "4 KMS CMKs; S3 storage + backup buckets Object Lock COMPLIANCE 2555d, block-public-access ALL, enforceSSL.", status: "ok" },
  { label: "WAF tuning", detail: "WAFv2 on both public ALBs; CommonRuleSet SizeRestrictions_BODY + XSS_BODY set to Count so large inline template HTML isn't 403'd.", status: "info" },
  { label: "Untrusted HTML", detail: "Stored email template HTML is only ever rendered inside an empty-sandbox <iframe> (no scripts/forms/nav/same-origin).", status: "ok" },
];

export const BACKUPS_DR: RefItem[] = [
  { label: "pgBackRest", detail: "Continuous WAL archiving + scheduled full/differential base backups to the KMS-encrypted BackupBucket.", status: "ok" },
  { label: "Logical dumps", detail: "Nightly pg_dump alongside the physical backups.", status: "ok" },
  { label: "AWS Backup", detail: "Vault with Vault Lock COMPLIANCE; scheduled jobs with 2555-day (7yr) retention.", status: "ok" },
  { label: "Restore drills", detail: "Documented restore-drill runbook (RTO validation); Postgres major-upgrade runbook.", status: "info" },
  { label: "Lifecycle", detail: "Backup noncurrent objects transition to Glacier at 30 days; retained to Object Lock expiry.", status: "info" },
];

export const OBSERVABILITY: RefItem[] = [
  { label: "CloudWatch alarms", detail: "CPU, disk, EC2 status checks, replication-slot lag, connection saturation, unhealthy-container count, backup-job failure.", status: "ok" },
  { label: "On-call", detail: "SNS topic wired to the alarms.", status: "ok" },
  { label: "CloudTrail", detail: "PHI data-event trail on the storage + backup buckets (object-level).", status: "ok" },
  { label: "Network + access logs", detail: "VPC flow logs; ALB per-request access logs (public + internal) to S3.", status: "ok" },
  { label: "Log archive", detail: "7-year Object Lock Glacier archive via Firehose.", status: "ok" },
  { label: "Cost guardrail", detail: "Monthly cost budget ($550) with alerting.", status: "info" },
  { label: "In-app logs", detail: "Logflare/vector not enabled — Studio Logs/Reports tabs are inert (accepted); this console surfaces IaC reference instead of live telemetry.", status: "warn" },
];

export const NETWORK: RefItem[] = [
  { label: "Compute", detail: `Single ${PROJECT.host}; the Next.js app runs as ECS Fargate (desiredCount 2) inside the Supabase VPC on internalClientSg.`, status: "info" },
  { label: "VPC", detail: `${PROJECT.vpcCidr}; VPC endpoints; VPC flow logs on.`, status: "info" },
  { label: "Ingress", detail: "Public: marketing app ALB (Cognito) + Studio ALB (Cognito). Private: internal data-API ALB → Kong :8000.", status: "info" },
  { label: "SG port map", detail: "Studio :3000 from ALB; Kong :8000 / Supavisor :5432/:6543 from internalClientSg; Kong admin/manager loopback-only.", status: "ok" },
];

/** The exposed data-plane APIs (documentation reference for the API section). */
export interface ApiSurface {
  name: string;
  base: string;
  note: string;
}

export const API_SURFACES: ApiSurface[] = [
  { name: "PostgREST (REST)", base: "{SUPABASE_URL}/rest/v1", note: "Auto REST over the exposed schemas. Cross-schema reads use the Accept-Profile header (e.g. marketinghub)." },
  { name: "GraphQL (pg_graphql)", base: "{SUPABASE_URL}/graphql/v1", note: "GraphQL over the graphql_public schema." },
  { name: "Storage", base: "{SUPABASE_URL}/storage/v1", note: "Object storage + signed URLs for the campaign-templates bucket." },
  { name: "Auth (GoTrue)", base: "{SUPABASE_URL}/auth/v1", note: "Present, but end-user identity is Cognito/SAML — the app does not use GoTrue login." },
];
