import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireAdminUser } from "@/lib/requireAdminUser";
import { LOGS_TABS } from "@/lib/console/tabs";
import {
  AnalyticsUnavailableError,
  listSources,
  queryLogs,
  type LogEntry,
} from "@/lib/console/logs";
import {
  LogsClient,
  type LogSourceOption,
} from "@/components/console/LogsClient";

// Reads request-time identity + live Logflare data; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Logs · MarketingHub",
};

/**
 * Logs explorer (Studio → Logs & Analytics parity, Wave 6). The initial load
 * queries the last hour of edge_logs (Kong/API) server-side through the
 * foundation lib; every follow-up query runs through the group-gated
 * /api/console/logs route. READ-ONLY — the surface issues only fixed,
 * allowlisted query templates; no user SQL reaches Logflare.
 *
 * Until the operator applies the staged Wave-6 enable (Kong analytics-v1-api
 * route + LOGFLARE_PRIVATE_ACCESS_TOKEN on the app task-def), the lib throws
 * AnalyticsUnavailableError and this page renders the honest "Analytics
 * unavailable" state — nothing else in the console changes.
 */
export default async function LogsPage() {
  // Server-side admin gate: mirrors the API handler (the initial query below
  // never routes through /api/console/logs, so the page must gate too).
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;

  // Only the picker fields cross to the client — the lib's severity SQL
  // expressions stay server-side.
  const sources: LogSourceOption[] = listSources().map((source) => ({
    id: source.id,
    label: source.label,
    severities: source.severity?.values,
  }));

  let initialEntries: LogEntry[] = [];
  let initialError: string | null = null;
  try {
    const to = new Date();
    const from = new Date(to.getTime() - 3_600_000);
    initialEntries = await queryLogs({ source: "edge_logs", from, to });
  } catch (err) {
    if (err instanceof AnalyticsUnavailableError) {
      return (
        <>
          <Guide id="observability.logs.page">
            <PageHeader title="Logs" />
          </Guide>
          <Guide id="observability.logs.tabs">
            <Tabs items={LOGS_TABS} />
          </Guide>
          <Guide id="observability.logs.unavailable">
            <Surface className="empty-state" glint>
              <h2>Analytics unavailable</h2>
              <p>
                Logflare did not answer through the data API — nothing else is
                affected.
              </p>
            </Surface>
          </Guide>
        </>
      );
    }
    // Analytics answered but the query failed — render the explorer with the
    // honest error so the user can adjust and retry.
    initialError =
      err instanceof Error
        ? err.message.replace(/^\[console:[\w-]+\] (?:[\w-]+ failed: )?/, "")
        : "Initial log query failed.";
  }

  return (
    <>
      <Guide id="observability.logs.page">
        <PageHeader title="Logs" />
      </Guide>
      <Guide id="observability.logs.tabs">
        <Tabs items={LOGS_TABS} />
      </Guide>
      <LogsClient
        sources={sources}
        initialEntries={initialEntries}
        initialError={initialError}
      />
    </>
  );
}
