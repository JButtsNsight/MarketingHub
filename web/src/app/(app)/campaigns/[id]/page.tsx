import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import {
  getCampaign,
  getCampaignCounts,
  getCampaignEngagement,
  getCampaignRecipients,
  listInboundMessages,
} from "@/lib/sms/repo";
import { getContactList } from "@/lib/contacts/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { CampaignActions } from "@/components/campaigns/CampaignActions";
import { InboxTable } from "@/components/campaigns/InboxTable";
import { LiveRefresher } from "@/components/live/LiveRefresher";
import { RecipientsTable } from "@/components/campaigns/RecipientsTable";
import { RescheduleControl } from "@/components/campaigns/RescheduleControl";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { formatSlot, zoneAbbr } from "@/lib/sms/schedule";
import {
  foldZoneCounts,
  getExplicitZoneCounts,
  zoneChip,
} from "@/lib/sms/zoneStats";

// Reads request-time identity + live outbox rows; never prerender.
export const dynamic = "force-dynamic";

/**
 * Single-campaign view. Server component: it loads the (server-only) repo
 * rows and 404s via `notFound()` for an unknown id. Renders the lifecycle
 * header (status badge, the send slot + zone — plus an "N zones" chip when
 * recipients span more than one — and template/board
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
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const { id } = await params;
  const campaign = await getCampaign(id, db);
  if (!campaign) notFound();

  const [counts, recipients, list, engagement, replies, explicitZones] =
    await Promise.all([
      getCampaignCounts(id, db),
      getCampaignRecipients(id, db),
      campaign.contact_list_id
        ? getContactList(campaign.contact_list_id, db)
        : Promise.resolve(null),
      getCampaignEngagement(id, db),
      listInboundMessages({ campaignId: id, limit: 50 }, db),
      getExplicitZoneCounts([id], db),
    ]);

  // Click-through denominator: rows that reached a phone. `sent` rows may
  // still settle either way; `undelivered` provably never arrived.
  const reached = counts.sent + counts.delivered;
  const ctr =
    engagement.tracked_links > 0 && reached > 0
      ? `${((engagement.recipients_clicked / reached) * 100).toFixed(1)}%`
      : "—";

  // Multi-zone audience chip — the same view-backed source the /campaigns and
  // /schedule chips use (getCampaignRecipients caps at 2000 rows, so deriving
  // the chip from it would disagree with those pages on large campaigns).
  const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const zones = zoneChip(
    foldZoneCounts(explicitZones.get(id), campaign.send_timezone, totalRows),
  );

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
            {zones ? (
              <>
                {" "}
                <Badge title={zones.title}>{zones.label}</Badge>
              </>
            ) : null}
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

      <LiveRefresher topic={[`mh:campaign:${campaign.id}`, "mh:inbox"]} />

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

        <Section eyebrow="Engagement" title="After the send">
          <div className="stat-grid">
            <StatCard
              label="Clicked"
              value={engagement.recipients_clicked}
              hint={
                engagement.tracked_links > 0
                  ? `${engagement.total_clicks} total clicks`
                  : "no tracked links in this message"
              }
              accent="var(--data-1)"
            />
            <StatCard
              label="Click-through"
              value={ctr}
              hint={`of ${reached} reached`}
              accent="var(--data-4)"
            />
            <StatCard
              label="Replies"
              value={engagement.replies}
              hint={
                engagement.unhandled_replies > 0
                  ? `${engagement.unhandled_replies} unhandled`
                  : "all handled"
              }
              accent="var(--data-2)"
            />
            {/* No accent: an opt-out is an attention signal, and StatCard
                accents are data-pool only. */}
            <StatCard
              label="Opt-outs"
              value={engagement.opt_outs}
              hint="STOPs after this send"
            />
          </div>
        </Section>

        {replies.length > 0 ? (
          <Section
            eyebrow="Inbox"
            title="Replies to this campaign"
            description="Newest first — the full inbox lives under Engage → Inbox."
          >
            <InboxTable messages={replies} showCampaign={false} />
          </Section>
        ) : null}

        <RecipientsTable
          campaignId={campaign.id}
          campaignStatus={campaign.status}
          recipients={recipients}
        />
      </div>
    </>
  );
}
