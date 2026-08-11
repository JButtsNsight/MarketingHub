import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { statusLabel, statusTone } from "@/components/campaigns/statusBadge";
import { formatBytes } from "@/components/storage/resumable";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getUserClient } from "@/lib/supabase";
import { getTemplateStats } from "@/lib/console/stats";
import { listBucket } from "@/lib/console/storage";
import {
  countSuppressions,
  countUnhandledInbound,
  getEngagementForCampaigns,
  listCampaignsWithCounts,
  type CampaignWithCounts,
} from "@/lib/sms/repo";
import type { CampaignEngagement } from "@/lib/sms/schema";

// Reads request-time identity + live Supabase counts; never prerender.
export const dynamic = "force-dynamic";

/** The engagement window for the headline numbers. */
const WINDOW_DAYS = 30;
/** Campaigns shown in the recent-campaigns table. */
const RECENT_LIMIT = 8;

interface CampaignRow extends CampaignWithCounts {
  engagement: CampaignEngagement;
}

/** Attempts that left our system (sent may still settle either way). */
function attempted(c: CampaignWithCounts): number {
  return c.counts.sent + c.counts.delivered + c.counts.undelivered;
}

const RECENT_COLUMNS: Column<CampaignRow>[] = [
  {
    key: "name",
    header: "campaign",
    render: (c) => <Link href={`/campaigns/${c.id}`}>{c.name}</Link>,
  },
  {
    key: "status",
    header: "status",
    width: "120px",
    render: (c) => (
      <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>
    ),
  },
  {
    key: "sent",
    header: "sent",
    mono: true,
    align: "right",
    width: "70px",
    render: (c) => attempted(c),
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
    key: "clicked",
    header: "clicked",
    mono: true,
    align: "right",
    width: "80px",
    render: (c) =>
      c.engagement.tracked_links > 0 ? c.engagement.recipients_clicked : "—",
  },
  {
    key: "replies",
    header: "replies",
    mono: true,
    align: "right",
    width: "80px",
    render: (c) => c.engagement.replies,
  },
  {
    key: "optouts",
    header: "opt-outs",
    mono: true,
    align: "right",
    width: "90px",
    render: (c) => c.engagement.opt_outs,
  },
];

/**
 * The admin jump-to cards (moved here from the retired /admin landing page).
 * Posture and the backend-services reference render on /infrastructure — one
 * card points there; no page duplicates another's content.
 */
const EXPLORE = [
  { href: "/admin/auth", title: "Authentication", desc: "Cognito session, GoTrue users, SSO, impersonation." },
  { href: "/admin/advisors", title: "Advisors", desc: "Security and performance lints." },
  { href: "/admin/cloud", title: "Cloud", desc: "Cloud-platform features and their status here." },
  { href: "/infrastructure", title: "Infrastructure", desc: "Services, security posture, backups, and observability." },
];

export default async function OverviewPage() {
  const user = await requireMarketingUser();
  // Per-user client (RLS `authenticated` role) when SUPABASE_JWT_SECRET is
  // set; the service-role fallback otherwise — identical to before.
  const db = await getUserClient(user);

  // Storage listing rides the same fan-out; a failure is shown, never faked.
  const [stats, campaigns, unhandled, suppressed, objects] = await Promise.all([
    getTemplateStats(db),
    listCampaignsWithCounts(db),
    countUnhandledInbound(db),
    countSuppressions(db),
    listBucket("").catch(() => null),
  ]);
  const engagement = await getEngagementForCampaigns(
    campaigns.map((c) => c.id),
    db,
  );

  const email = stats.byType.find((t) => t.label === "email")?.count ?? 0;
  const text = stats.byType.find((t) => t.label === "text")?.count ?? 0;

  const zero: CampaignEngagement = {
    campaign_id: "",
    tracked_links: 0,
    recipients_clicked: 0,
    total_clicks: 0,
    replies: 0,
    unhandled_replies: 0,
    opt_outs: 0,
  };
  const withEngagement: CampaignRow[] = campaigns.map((c) => ({
    ...c,
    engagement: engagement.get(c.id) ?? { ...zero, campaign_id: c.id },
  }));

  // Headline window: campaigns whose send instant falls in the last 30 days
  // (upcoming ones contribute zeros until they send).
  const windowStart = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentWindow = withEngagement.filter(
    (c) => new Date(c.send_at).getTime() >= windowStart,
  );
  const sum = (pick: (c: CampaignRow) => number) =>
    recentWindow.reduce((total, c) => total + pick(c), 0);

  const sent30 = sum(attempted);
  const delivered30 = sum((c) => c.counts.delivered);
  const clicked30 = sum((c) => c.engagement.recipients_clicked);
  const replies30 = sum((c) => c.engagement.replies);
  const optOuts30 = sum((c) => c.engagement.opt_outs);

  const recent = withEngagement.slice(0, RECENT_LIMIT);

  const folders = objects?.filter((o) => o.isFolder).length ?? 0;
  const files = objects?.filter((o) => !o.isFolder).length ?? 0;
  const totalSize = objects?.reduce((sum, o) => sum + (o.size ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title="Overview"
      />

      <div className="stack">
        <div className="stat-grid">
          <StatCard
            label="Templates"
            value={stats.total}
            hint={stats.latest ? `latest ${stats.latest.slice(0, 10)}` : "no rows yet"}
          />
          <StatCard label="Email" value={email} hint="email templates" accent="var(--data-2)" />
          <StatCard label="Text" value={text} hint="text templates" accent="var(--data-3)" />
          <StatCard
            label="Categories"
            value={stats.byCategory.length}
            hint="distinct categories"
            accent="var(--data-1)"
          />
        </div>

        <Section
          eyebrow="Analytics"
          title={`Engagement — last ${WINDOW_DAYS} days`}
          description="Live send, click, reply, and opt-out numbers across every campaign whose send slot fell inside the window."
        >
          <div className="stat-grid">
            <StatCard
              label="Messages sent"
              value={sent30}
              hint={`${recentWindow.length} campaign${recentWindow.length === 1 ? "" : "s"}`}
              accent="var(--data-1)"
            />
            <StatCard
              label="Delivered"
              value={delivered30}
              hint="delivery reports received"
              accent="var(--data-3)"
            />
            <StatCard
              label="Clicked"
              value={clicked30}
              hint="recipients who tapped a link"
              accent="var(--data-4)"
            />
            <StatCard
              label="Replies"
              value={replies30}
              hint={
                unhandled > 0
                  ? `${unhandled} unhandled in the inbox`
                  : "inbox is clear"
              }
              accent="var(--data-2)"
            />
            {/* No accents on the attention counts: StatCard accents are
                data-pool only (red is reserved for status Badges). */}
            <StatCard
              label="Opt-outs"
              value={optOuts30}
              hint="STOPs after a send"
            />
            <StatCard
              label="STOP list"
              value={suppressed}
              hint="numbers never texted again"
            />
          </div>
        </Section>

        <Section
          eyebrow="Analytics"
          title="Recent campaigns"
          description="Newest first — campaigns without tracked links show a dash for clicks."
        >
          <DataTable
            columns={RECENT_COLUMNS}
            rows={recent}
            getRowKey={(c) => c.id}
            empty="No campaigns yet."
          />
        </Section>

        {/* Admin surfaces sit below the marketing numbers — marketing users
            see their stats first. */}
        <Section eyebrow="Explore" title="Jump to a section">
          <div className="card-grid">
            {EXPLORE.map((c) => (
              <Link key={c.href} href={c.href} className="surface glint link-card">
                <span className="link-card-title">{c.title}</span>
                <span className="link-card-desc">{c.desc}</span>
              </Link>
            ))}
          </div>
        </Section>

        <Section
          eyebrow="Object storage"
          title="Storage"
          description="The private campaign-templates bucket."
          actions={<Link href="/storage">Open</Link>}
        >
          {objects == null ? (
            <p className="note">Storage listing is currently unavailable.</p>
          ) : (
            <p className="note">
              <span className="mono">{folders}</span> folders ·{" "}
              <span className="mono">{files}</span> files ·{" "}
              <span className="mono">{formatBytes(totalSize)}</span>
            </p>
          )}
        </Section>
      </div>
    </>
  );
}
