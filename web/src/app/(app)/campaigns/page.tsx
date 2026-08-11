import Link from "next/link";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import {
  listCampaignsWithCounts,
  type CampaignWithCounts,
} from "@/lib/sms/repo";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { formatSlot, zoneAbbr } from "@/lib/sms/schedule";

// Reads request-time identity + live campaign rows; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "SMS Campaigns · MarketingHub",
};

/** Every outbox row, whatever its status — the campaign's audience size. */
function totalRecipients(c: CampaignWithCounts): number {
  return Object.values(c.counts).reduce((sum, n) => sum + n, 0);
}

const COLUMNS: Column<CampaignWithCounts>[] = [
  {
    key: "name",
    header: "name",
    render: (c) => <Link href={`/campaigns/${c.id}`}>{c.name}</Link>,
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
    render: (c) =>
      `${c.send_date} · ${formatSlot(c.send_time)} ${zoneAbbr(c.send_timezone)}`,
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

  return (
    <>
      <PageHeader
        eyebrow="Build"
        title="SMS Campaigns"
        count={`${campaigns.length} total`}
        actions={
          <>
            <Link className="type-chip" href="/campaigns/schedule">
              Schedule
            </Link>
            <Link className="type-chip" href="/campaigns/lists">
              Contact lists
            </Link>
            <Link className="btn-primary" href="/campaigns/new">
              New campaign
            </Link>
          </>
        }
      />

      {campaigns.length > 0 ? (
        <DataTable
          columns={COLUMNS}
          rows={campaigns}
          getRowKey={(c) => c.id}
          empty="No campaigns."
        />
      ) : (
        <Surface className="empty-state" glint>
          <h2>No campaigns yet</h2>
          <p>
            Pick a text template, a contact list, and a weekday send slot.
          </p>
          <Link className="btn-primary" href="/campaigns/new">
            New campaign
          </Link>
        </Surface>
      )}
    </>
  );
}
