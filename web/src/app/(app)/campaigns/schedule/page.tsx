import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import {
  listCampaignsWithCounts,
  type CampaignWithCounts,
} from "@/lib/sms/repo";
import { formatSlot, zoneAbbr } from "@/lib/sms/schedule";
import {
  foldZoneCounts,
  getExplicitZoneCounts,
  zoneChip,
} from "@/lib/sms/zoneStats";
import { Guide } from "@/components/guide/Guide";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { LiveRefresher } from "@/components/live/LiveRefresher";

// Reads request-time identity + live campaign rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Blast schedule · MarketingHub",
};

/** Campaign states that occupy the schedule (terminal ones are history). */
const ON_SCHEDULE = new Set(["scheduled", "paused", "sending"]);

/** Recipients still waiting to go out. */
function pendingCount(c: CampaignWithCounts): number {
  return c.counts.pending + c.counts.claimed + c.counts.sending;
}

/** Every outbox row, whatever its status — the campaign's audience size. */
function totalRecipients(c: CampaignWithCounts): number {
  return Object.values(c.counts).reduce((sum, n) => sum + n, 0);
}

/** "2026-08-03" → "Monday, August 3" (deterministic, UTC-anchored). */
function humanDate(sendDate: string): string {
  const [y, m, d] = sendDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The blast schedule: every campaign still occupying a slot (scheduled,
 * paused, or actively sending), grouped by send date in send-instant order.
 * Server component over the same repo read as the campaigns list.
 */
export default async function SchedulePage() {
  // Server-side group gate: mirrors the API handlers.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const campaigns = (await listCampaignsWithCounts(db))
    .filter((c) => ON_SCHEDULE.has(c.status))
    .sort((a, b) => a.send_at.localeCompare(b.send_at));

  // Per-recipient zones: fold explicit send_timezone rows + the campaign-zone
  // fallback into one "N zones" chip per multi-zone campaign.
  const explicitZones = await getExplicitZoneCounts(
    campaigns.map((c) => c.id),
    db,
  );
  const zonesFor = (c: CampaignWithCounts) =>
    zoneChip(
      foldZoneCounts(explicitZones.get(c.id), c.send_timezone, totalRecipients(c)),
    );

  const byDate = new Map<string, CampaignWithCounts[]>();
  for (const c of campaigns) {
    const list = byDate.get(c.send_date) ?? [];
    list.push(c);
    byDate.set(c.send_date, list);
  }

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title={
          <Guide id="campaigns.schedule.title">
            <span>Blast schedule</span>
          </Guide>
        }
        count={`${campaigns.length} on the calendar`}
        actions={
          <>
            <Guide id="campaigns.schedule.campaigns-link">
              <Link className="type-chip" href="/campaigns">
                Campaigns
              </Link>
            </Guide>
            <Guide id="campaigns.schedule.new-link">
              <Link className="btn-primary" href="/campaigns/new">
                New campaign
              </Link>
            </Guide>
          </>
        }
      />

      <LiveRefresher topic="mh:schedule" />

      {campaigns.length > 0 ? (
        <div className="stack">
          {Array.from(byDate.entries()).map(([date, dayCampaigns]) => (
            <Guide id="campaigns.schedule.day" key={date}>
              <Surface as="section" className="panel schedule-day" glint>
                <h2 className="schedule-day-head">
                  {humanDate(date)} <span className="mono muted">{date}</span>
                </h2>
                <ul className="schedule-day-list">
                  {dayCampaigns.map((c) => {
                    const zones = zonesFor(c);
                    return (
                      <li key={c.id} className="schedule-entry">
                        <span className="mono schedule-slot">
                          {formatSlot(c.send_time)} {zoneAbbr(c.send_timezone)}
                        </span>
                        {zones ? (
                          <Badge title={zones.title}>{zones.label}</Badge>
                        ) : null}
                        <Guide id="campaigns.schedule.open-campaign">
                          <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
                        </Guide>
                        <Badge tone={statusTone(c.status)}>
                          {statusLabel(c.status)}
                        </Badge>
                        <span className="mono muted">
                          {pendingCount(c)} of {totalRecipients(c)} to send
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Surface>
            </Guide>
          ))}
        </div>
      ) : (
        <Surface className="empty-state" glint>
          <h2>Nothing scheduled</h2>
          <p>
            Scheduled, paused, and sending campaigns appear here, grouped by
            send day.
          </p>
          <Guide id="campaigns.schedule.new-link">
            <Link className="btn-primary" href="/campaigns/new">
              New campaign
            </Link>
          </Guide>
        </Surface>
      )}
    </>
  );
}
