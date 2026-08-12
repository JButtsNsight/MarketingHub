import { PageHeader } from "@/components/ui/PageHeader";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { listHistory, listSnippets } from "@/lib/console/sql";
import { SqlConsole } from "@/components/console/SqlConsole";

// Reads request-time identity + live snippet/history rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "SQL Editor · MarketingHub",
};

/**
 * The SQL editor (Studio parity). Queries run through postgres-meta as
 * supabase_admin behind the platform section gate; statements that cannot be
 * proven read-only take an explicit confirm step, and every run is recorded
 * in console_query_history.
 */
export default async function SqlPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

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
      />
      <SqlConsole initialSnippets={snippets} initialHistory={history} />
    </>
  );
}
