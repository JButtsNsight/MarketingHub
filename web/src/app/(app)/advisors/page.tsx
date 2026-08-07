import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { runAdvisors, type AdvisorReport } from "@/lib/console/advisors";
import { AdvisorsClient } from "@/components/console/AdvisorsClient";

// Reads request-time identity + live catalog lints; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Advisors · MarketingHub",
};

/**
 * Advisors — the console's parity for Supabase Studio's Security + Performance
 * advisor screen. The fixed lint suite (RLS-disabled, no-policy, mutable
 * search_path, SECURITY DEFINER views, unindexed/duplicate/unused indexes, …)
 * runs server-side through the service-role data plane; findings render
 * grouped by severity (ERROR / WARN / INFO). This surface is READ-ONLY — the
 * client only re-runs the suite and filters by level, so there is no write to
 * guard behind a confirm.
 */
export default async function AdvisorsPage() {
  // Server-side group gate: mirrors the API handler.
  await requireMarketingUser();

  let report: AdvisorReport | null = null;
  try {
    report = await runAdvisors();
  } catch {
    report = null;
  }

  if (!report) {
    return (
      <>
        <PageHeader eyebrow="Database" title="Advisors" />
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Advisors" />
      <AdvisorsClient initialReport={report} />
    </>
  );
}
