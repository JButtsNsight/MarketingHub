import { PageHeader } from "@/components/ui/PageHeader";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listHistory, listSnippets } from "@/lib/console/sql";
import { SqlConsole } from "@/components/console/SqlConsole";

// Reads request-time identity + live snippet/history rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "SQL Editor · MarketingHub",
};

/**
 * The SQL editor (Studio parity). Queries run through postgres-meta as
 * supabase_admin behind the marketing group gate; statements that cannot be
 * proven read-only take an explicit confirm step, and every run is recorded
 * in console_query_history.
 */
export default async function SqlPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  // Snippet/history tables may predate their migration on a fresh
  // environment — an empty editor beats a hard 500.
  let snippets: Awaited<ReturnType<typeof listSnippets>> = [];
  let history: Awaited<ReturnType<typeof listHistory>> = [];
  try {
    [snippets, history] = await Promise.all([listSnippets(), listHistory()]);
  } catch {
    // rendered empty; saving/running will surface real errors
  }

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title="SQL Editor"
        subtitle="Runs as the database superuser through postgres-meta — writes take an explicit confirm, and every run is recorded in the query history."
      />
      <SqlConsole initialSnippets={snippets} initialHistory={history} />
    </>
  );
}
