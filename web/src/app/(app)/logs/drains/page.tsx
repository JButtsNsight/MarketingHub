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
    detail: "Log drains ship self-hosted at Logflare 1.36.1.",
    status: "info",
  },
  {
    label: "Not enabled here",
    detail:
      "Kong's analytics route is read-only, so no drain exists or can be created.",
    status: "warn",
  },
  {
    label: "Why it stays off",
    detail: "Drain config is a write surface with external egress — deliberately off.",
    status: "info",
  },
];

/** What already does the drain job (durable, alertable log delivery) in this stack. */
const COVERAGE_ROWS: RefRow[] = [
  {
    label: "In-stack pipeline (vector → Logflare)",
    detail:
      "Ships the seven service log streams to a queryable in-stack store — the data behind Logs and Reports.",
    status: "ok",
  },
  {
    label: "CloudWatch — infrastructure log & alarm truth",
    detail:
      "CloudWatch alarms, ALB access logs and VPC flow logs cover off-host delivery and alerting.",
    status: "ok",
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

      <div className="stack">
        <Section
          eyebrow="Capability"
          title="Drains are real upstream — and off here"
        >
          <RefList items={CAPABILITY_ROWS} />
        </Section>

        <Section eyebrow="Coverage" title="What does the drain job instead">
          <RefList items={COVERAGE_ROWS} />
        </Section>

        <Section eyebrow="Pipeline" title="vector → Logflare routing map">
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
