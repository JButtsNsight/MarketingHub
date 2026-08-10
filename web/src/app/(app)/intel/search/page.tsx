import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { SearchPanel } from "@/components/intel/SearchPanel";

// Request-time identity; results and the async answer are per-query live
// state. Never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Intel Search · MarketingHub",
};

/**
 * Agentic search over the competitor-intel corpus (q lives in the URL, so
 * searches are shareable). Full-text search ranks passages immediately;
 * answer synthesis with citations arrives asynchronously via the headless-
 * claude gateway — SearchPanel owns that two-phase flow and every degraded
 * state. This page no longer touches the embedding provider at all: the
 * pgvector pipeline stays dormant, surfaced on the document/source pages
 * instead (deliberately — it is the parity demonstration).
 */
export default async function IntelSearchPage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader title="Intel Search" />
      <div className="stack">
        <SearchPanel />
      </div>
    </>
  );
}
