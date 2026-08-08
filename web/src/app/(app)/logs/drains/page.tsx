import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList, type RefRow } from "@/components/ui/RefList";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { LOGS_TABS } from "@/lib/console/tabs";

// Static reference content, but the page still reads request-time identity
// for the group gate; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Log Drains · MarketingHub",
};

/**
 * Log Drains (Studio → Logs → Drains parity) — an honest static capability
 * panel, deliberately fetch-free.
 *
 * Drains are a REAL self-hosted capability at our pin (Logflare 1.36.1 ships
 * the backend adaptors — webhook, OTLP, Datadog, Loki, S3, Syslog, … — and
 * Studio drives them through /api/backends + /api/rules). They are NOT enabled
 * here on purpose: the only path from this app to Logflare is Kong's
 * analytics route, which exposes ONLY the read-only query endpoints
 * (/api/endpoints/query/*). The management API a drain needs is unreachable, and
 * configuring drains is a WRITE surface (creates backends/rules and causes
 * egress from the analytics container) — out of scope for the read-only logs
 * surfaces this wave.
 *
 * What covers the drain use-case in this stack instead: the in-stack
 * vector → Logflare pipeline (7 service log streams, queryable from
 * Logs/Reports) and CloudWatch as the infrastructure log-and-alarm truth.
 */

/** One shipped log stream: container → vector sink → Logflare source → console source. */
interface PipelineRoute {
  container: string;
  logflareSource: string;
  consoleSource: string;
  label: string;
}

/**
 * The complete vector routing table at pin supabase/supabase@v1.26.05
 * (docker/volumes/logs/vector.yml): vector tails the host docker socket and
 * forwards exactly these seven containers' logs to the in-stack Logflare.
 * Everything else (studio, meta, imgproxy, pooler, analytics itself) is
 * dropped and never ingested.
 */
const PIPELINE_ROUTES: PipelineRoute[] = [
  {
    container: "supabase-kong",
    logflareSource: "cloudflare.logs.prod",
    consoleSource: "edge_logs",
    label: "API / Edge (Kong)",
  },
  {
    container: "supabase-db",
    logflareSource: "postgres.logs",
    consoleSource: "postgres_logs",
    label: "Postgres",
  },
  {
    container: "supabase-auth",
    logflareSource: "gotrue.logs.prod",
    consoleSource: "auth_logs",
    label: "Auth (GoTrue)",
  },
  {
    container: "supabase-rest",
    logflareSource: "postgREST.logs.prod",
    consoleSource: "postgrest_logs",
    label: "PostgREST",
  },
  {
    container: "realtime-dev.supabase-realtime",
    logflareSource: "realtime.logs.prod",
    consoleSource: "realtime_logs",
    label: "Realtime",
  },
  {
    container: "supabase-storage",
    logflareSource: "storage.logs.prod.2",
    consoleSource: "storage_logs",
    label: "Storage",
  },
  {
    container: "supabase-edge-functions",
    logflareSource: "deno-relay-logs",
    consoleSource: "function_edge_logs",
    label: "Edge Functions",
  },
];

const PIPELINE_COLUMNS: Column<PipelineRoute>[] = [
  { key: "container", header: "container", mono: true, width: "28%" },
  { key: "logflareSource", header: "logflare source", mono: true, width: "26%" },
  {
    key: "consoleSource",
    header: "console source",
    width: "22%",
    render: (r) => <span className="mono">{r.consoleSource}</span>,
  },
  { key: "label", header: "service", render: (r) => <Badge>{r.label}</Badge> },
];

/** Why there is no drain config form on this page. */
const CAPABILITY_ROWS: RefRow[] = [
  {
    label: "Upstream capability",
    detail:
      "Log Drains are real self-hosted at our pin: Logflare 1.36.1 ships the drain backend adaptors (custom webhook, OTLP, Datadog, Loki, Amazon S3, Syslog, …), and Supabase Studio configures them through Logflare's management API (/api/backends + /api/rules).",
    status: "info",
  },
  {
    label: "Not enabled here",
    detail:
      "This console reaches Logflare only through Kong's analytics route, which exposes the read-only query endpoints (/api/endpoints/query/*). The management API a drain requires is deliberately unreachable, so no drain exists and none can be created or listed from here.",
    status: "warn",
  },
  {
    label: "Why it stays off",
    detail:
      "Configuring a drain is a write surface — it creates Logflare backends and rules and opens egress from the analytics container to an external destination. The Wave-6 logs surfaces are read-only by design; enabling drains would be a deliberate future infrastructure decision, not a console toggle.",
    status: "info",
  },
];

/** What already does the drain job (durable, alertable log delivery) in this stack. */
const COVERAGE_ROWS: RefRow[] = [
  {
    label: "In-stack pipeline (vector → Logflare)",
    detail:
      "The supabase-vector container ships all seven service log streams below into the in-stack Logflare (Postgres backend). That is the data behind Logs and Reports — service logs already land in a queryable store without leaving the host.",
    status: "ok",
  },
  {
    label: "CloudWatch — infrastructure log & alarm truth",
    detail:
      "Off-host delivery and alerting already exist where they matter: CloudWatch alarms (CPU, disk, EC2 status checks, unhealthy-container count, backup-job failure) wired to on-call SNS, ALB per-request access logs and VPC flow logs to S3, and the 7-year Object Lock Glacier archive. For infrastructure truth, CloudWatch is the drain.",
    status: "ok",
  },
  {
    label: "Capacity & health watch",
    detail:
      "Operating guidance for the analytics pipeline itself (host CPU/memory headroom, analytics/kong container health, query-load symptoms) lives in the runbook: docs/runbooks/w6-analytics-headroom.md.",
    status: "info",
  },
];

export default async function LogDrainsPage() {
  // Server-side group gate: logs surfaces are sensitive (PHI-adjacent request
  // data) even when the page itself is static reference content.
  await requireMarketingUser();

  return (
    <>
      <PageHeader title="Log Drains" />
      <Tabs items={LOGS_TABS} />

      <p className="ref-note" style={{ marginBottom: "18px" }}>
        <Badge>reference</Badge>
        <span>
          Static capability panel — nothing on this page queries Logflare. Log
          Drains are not enabled in this stack; the sections below explain why,
          and what covers the use-case instead.
        </span>
      </p>

      <div className="stack">
        <Section
          eyebrow="Capability"
          title="Drains are real upstream — and off here"
          description="Logflare 1.36.1 supports log drains self-hosted, but this console's analytics route is read-only, so there is nothing to configure on this page."
        >
          <RefList items={CAPABILITY_ROWS} />
        </Section>

        <Section
          eyebrow="Coverage"
          title="What does the drain job instead"
          description="Durable, queryable, alertable log delivery already exists on two paths."
        >
          <RefList items={COVERAGE_ROWS} />
        </Section>

        <Section
          eyebrow="Pipeline"
          title="vector → Logflare routing map"
          description="The seven service log streams vector ships in-stack — the exact sources the Logs explorer queries."
        >
          <DataTable
            columns={PIPELINE_COLUMNS}
            rows={PIPELINE_ROUTES}
            getRowKey={(r) => r.consoleSource}
          />
        </Section>
      </div>
    </>
  );
}
