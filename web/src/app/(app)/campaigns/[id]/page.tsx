import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  getCampaign,
  getCampaignCounts,
  getCampaignRecipients,
} from "@/lib/sms/repo";
import { getContactList } from "@/lib/contacts/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { CampaignActions } from "@/components/campaigns/CampaignActions";
import { RecipientsTable } from "@/components/campaigns/RecipientsTable";
import { RescheduleControl } from "@/components/campaigns/RescheduleControl";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { formatSlot, zoneAbbr } from "@/lib/sms/schedule";

// Reads request-time identity + live outbox rows; never prerender.
export const dynamic = "force-dynamic";

/**
 * Single-campaign view. Server component: it loads the (server-only) repo
 * rows and 404s via `notFound()` for an unknown id. Renders the lifecycle
 * header (status badge, the 11:30 AM ET send instant, template/board
 * provenance), the per-status recipient StatCards, the pause/resume/cancel
 * controls, and the full outbox table with the failed_ambiguous review lane.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Server-side group gate: mirrors the API handlers so this read page can't
  // be viewed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();

  const [counts, recipients, list] = await Promise.all([
    getCampaignCounts(id),
    getCampaignRecipients(id),
    campaign.contact_list_id
      ? getContactList(campaign.contact_list_id)
      : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="SMS Campaign"
        title={campaign.name}
        subtitle={
          <>
            <Badge tone={statusTone(campaign.status)}>
              {statusLabel(campaign.status)}
            </Badge>{" "}
            <span className="mono">
              {campaign.send_date}, {formatSlot(campaign.send_time)}{" "}
              {zoneAbbr(campaign.send_timezone)}
            </span>
            {" · template "}
            <span className="mono">{campaign.template_id}</span>
            {list ? (
              <>
                {" · list "}
                <Link href={`/campaigns/lists/${list.id}`}>{list.name}</Link>
              </>
            ) : null}
            {campaign.monday_board_id ? (
              <>
                {" · board "}
                <span className="mono">{campaign.monday_board_id}</span>
                {" · column "}
                <span className="mono">{campaign.monday_phone_column_id}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <RescheduleControl
              campaignId={campaign.id}
              status={campaign.status}
              sendDate={campaign.send_date}
              sendTime={campaign.send_time}
              sendTimezone={campaign.send_timezone}
            />
            <CampaignActions
              campaignId={campaign.id}
              status={campaign.status}
            />
          </>
        }
      />

      <div className="stack">
        <div className="stat-grid">
          <StatCard label="Pending" value={counts.pending} />
          <StatCard
            label="Sent"
            value={counts.sent}
            accent="var(--data-2)"
          />
          <StatCard
            label="Delivered"
            value={counts.delivered}
            accent="var(--data-3)"
          />
          {/* No accent on the failure cards: StatCard accents are data-pool
              only (red is reserved for the status Badges). */}
          <StatCard label="Undelivered" value={counts.undelivered} />
          <StatCard label="Failed" value={counts.failed} />
          <StatCard label="Ambiguous" value={counts.failed_ambiguous} />
          <StatCard label="Suppressed" value={counts.suppressed} />
          {/* Skipped = invalid/duplicate phones at creation time — without it
              the cards do not add up to the loaded audience. */}
          <StatCard label="Skipped" value={counts.skipped} />
        </div>

        <RecipientsTable
          campaignId={campaign.id}
          campaignStatus={campaign.status}
          recipients={recipients}
        />
      </div>
    </>
  );
}
