import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import {
  listCampaignsWithCounts,
  type CampaignWithCounts,
} from "@/lib/sms/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { SMS_TABS } from "@/components/sms/tabs";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { formatSlot, zoneAbbr } from "@/lib/sms/schedule";
import {
  foldZoneCounts,
  getExplicitZoneCounts,
  zoneChip,
} from "@/lib/sms/zoneStats";

// Reads request-time identity + live campaign rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "SMS Campaigns · MarketingHub",
};

/** Every outbox row, whatever its status — the campaign's audience size. */
function totalRecipients(c: CampaignWithCounts): number {
  return Object.values(c.counts).reduce((sum, n) => sum + n, 0);
}

/** A table row: campaign + its multi-zone chip (null = single zone). */
type CampaignRow = CampaignWithCounts & {
  zones: ReturnType<typeof zoneChip>;
};

const COLUMNS: Column<CampaignRow>[] = [
  {
    key: "name",
    header: "name",
    render: (c) => (
      <Guide id="campaigns.list.open-campaign">
        <Link href={`/campaigns/${c.id}`}>{c.name}</Link>
      </Guide>
    ),
  },
  {
    key: "status",
    header: "status",
    width: "140px",
    render: (c) => (
      <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>
    ),
  },
  {
    key: "send",
    header: "sends",
    mono: true,
    width: "220px",
    render: (c) => (
      <>
        {`${c.send_date} · ${formatSlot(c.send_time)} ${zoneAbbr(c.send_timezone)}`}
        {c.zones ? (
          <>
            {" "}
            <Badge title={c.zones.title}>{c.zones.label}</Badge>
          </>
        ) : null}
      </>
    ),
  },
  {
    key: "total",
    header: "recipients",
    mono: true,
    align: "right",
    width: "100px",
    render: (c) => totalRecipients(c),
  },
  {
    key: "sent",
    header: "sent",
    mono: true,
    align: "right",
    width: "70px",
    render: (c) => c.counts.sent,
  },
  {
    key: "delivered",
    header: "delivered",
    mono: true,
    align: "right",
    width: "90px",
    render: (c) => c.counts.delivered,
  },
  {
    key: "failed",
    header: "failed",
    mono: true,
    align: "right",
    width: "70px",
    // failed_ambiguous rows are unresolved sends awaiting review — they count
    // as failures until the webhook or a human says otherwise.
    render: (c) => c.counts.failed + c.counts.failed_ambiguous,
  },
];

/**
 * SMS campaigns list. Server component: it reads the (server-only) repo and
 * renders every campaign (newest first) with per-status recipient counts.
 */
export default async function CampaignsPage() {
  // Server-side group gate: mirrors the API handlers so this read page can't
  // be browsed by an authenticated employee outside the `marketing` group.
  const user = await requireMarketingUser();
  const db = await getUserClient(user);

  const campaigns = await listCampaignsWithCounts(db);
  // Per-recipient zones: fold explicit send_timezone rows + the campaign-zone
  // fallback into one "N zones" chip per multi-zone campaign.
  const explicitZones = await getExplicitZoneCounts(
    campaigns.map((c) => c.id),
    db,
  );
  const rows: CampaignRow[] = campaigns.map((c) => ({
    ...c,
    zones: zoneChip(
      foldZoneCounts(explicitZones.get(c.id), c.send_timezone, totalRecipients(c)),
    ),
  }));

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title={
          <Guide id="campaigns.list.title">
            <span>SMS Campaigns</span>
          </Guide>
        }
        count={`${campaigns.length} total`}
        actions={
          <>
            <Guide id="campaigns.list.schedule-link">
              <Link className="type-chip" href="/campaigns/schedule">
                Schedule
              </Link>
            </Guide>
            <Guide id="campaigns.list.lists-link">
              <Link className="type-chip" href="/campaigns/lists">
                Contact lists
              </Link>
            </Guide>
            <Guide id="campaigns.list.new-link">
              <Link className="btn-primary" href="/campaigns/new">
                New campaign
              </Link>
            </Guide>
          </>
        }
      />
      <Guide id="campaigns.shell.tabs">
        <Tabs items={SMS_TABS} />
      </Guide>

      {campaigns.length > 0 ? (
        <Guide id="campaigns.list.table">
          <DataTable
            columns={COLUMNS}
            rows={rows}
            getRowKey={(c) => c.id}
            empty="No campaigns."
          />
        </Guide>
      ) : (
        <Surface className="empty-state" glint>
          <h2>No campaigns yet</h2>
          <p>
            Pick a text template, a contact list, and a weekday send slot.
          </p>
          <Guide id="campaigns.list.new-link">
            <Link className="btn-primary" href="/campaigns/new">
              New campaign
            </Link>
          </Guide>
        </Surface>
      )}
    </>
  );
}
