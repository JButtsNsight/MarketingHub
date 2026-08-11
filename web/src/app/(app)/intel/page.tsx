import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchPanel } from "@/components/intel/SearchPanel";
import { SourcesManager } from "@/components/intel/SourcesManager";

// Reads request-time identity; list data is fetched live from the group-gated
// /api/intel routes. Never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Competitor Intel · MarketingHub",
};

/**
 * Competitor-intel home: agentic search over the corpus, then the sources
 * library. Server component enforces the marketing-group gate (mirrors the
 * API handlers). SearchPanel owns the two-phase search flow (q lives in the
 * URL — /intel?q=… — so searches are shareable); SourcesManager owns
 * list/create/edit/delete against /api/intel/sources. The old /intel/search
 * page 308s here with its query intact.
 */
export default async function IntelPage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader title="Competitor Intel" />
      <div className="stack">
        <SearchPanel />
        <div className="stack">
          <span className="eyebrow">Sources</span>
          <SourcesManager />
        </div>
      </div>
    </>
  );
}
