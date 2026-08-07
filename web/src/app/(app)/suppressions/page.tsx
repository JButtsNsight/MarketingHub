import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { countSuppressions, listSuppressions } from "@/lib/sms/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { AddSuppressionForm } from "@/components/campaigns/AddSuppressionForm";
import { SuppressionsTable } from "@/components/campaigns/SuppressionsTable";

// Reads request-time identity + live STOP-list rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Suppressions · MarketingHub",
};

/**
 * The STOP list: who never gets texted again, and why. Webhook `stop`
 * entries (the person texted STOP) are permanent; `manual` entries carry
 * who/why provenance and can be removed with an audited two-step. Search is
 * a plain GET form — the server matches digits against the stored E.164.
 */
export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't
  // be browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  const { q } = await searchParams;
  const [suppressions, total] = await Promise.all([
    listSuppressions(q ? { query: q } : {}),
    countSuppressions(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Engage"
        title="Suppressions"
        count={`${total} suppressed`}
        actions={<AddSuppressionForm />}
      />

      <div className="stack">
        <form method="get" className="field" role="search">
          <label htmlFor="suppressions-q">Search by digits</label>
          <input
            id="suppressions-q"
            name="q"
            type="search"
            className="surface control"
            placeholder="e.g. 555 0100"
            defaultValue={q ?? ""}
          />
        </form>

        <SuppressionsTable suppressions={suppressions} />
      </div>
    </>
  );
}
