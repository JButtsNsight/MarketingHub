import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { PageHeader } from "@/components/ui/PageHeader";
import { SourcesManager } from "@/components/intel/SourcesManager";

// Reads request-time identity; list data is fetched live from the group-gated
// /api/intel routes. Never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Competitor Intel · MarketingHub",
};

/**
 * Competitor-intel home: the sources library. Server component enforces the
 * marketing-group gate (mirrors the API handlers); the client manager owns
 * list/create/edit/delete against /api/intel/sources.
 */
export default async function IntelPage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader
        title="Competitor Intel"
        actions={
          <Link className="type-chip" href="/intel/search">
            Search
          </Link>
        }
      />
      <div className="stack">
        <SourcesManager />
      </div>
    </>
  );
}
