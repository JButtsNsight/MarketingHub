import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listAttentionRecipients } from "@/lib/sms/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { AttentionTable } from "@/components/campaigns/AttentionTable";

// Reads request-time identity + live outbox rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Review queue · MarketingHub",
};

/**
 * The cross-campaign needs-attention queue: every outbox row that stopped
 * moving — `failed_ambiguous` (the POST may have landed; a human decides),
 * `failed` (terminal after retries), and `undelivered` (carrier rejection —
 * informational, retrying would double-text).
 */
export default async function ReviewPage() {
  // Server-side group gate: mirrors the API handlers so this read page can't
  // be browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  const rows = await listAttentionRecipients();
  const ambiguous = rows.filter((r) => r.status === "failed_ambiguous").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const undelivered = rows.filter((r) => r.status === "undelivered").length;

  return (
    <>
      <PageHeader
        eyebrow="Engage"
        title="Review queue"
        count={
          ambiguous > 0
            ? `${ambiguous} awaiting a decision`
            : "no decisions pending"
        }
        subtitle="Sends that stopped moving, across every campaign. Ambiguous rows are never retried automatically — a duplicate patient text is worse than a missed one, so a human decides here."
      />

      <div className="stack">
        <div className="stat-grid">
          {/* No accents: these are failure/attention counts, and StatCard
              accents are data-pool only (red is reserved for status Badges). */}
          <StatCard
            label="Ambiguous"
            value={ambiguous}
            hint="may have sent — decide below"
          />
          <StatCard label="Failed" value={failed} hint="terminal, retryable" />
          <StatCard
            label="Undelivered"
            value={undelivered}
            hint="carrier rejected — informational"
          />
        </div>

        <AttentionTable rows={rows} />
      </div>
    </>
  );
}
