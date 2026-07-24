import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList } from "@/components/ui/RefList";
import { LineChart } from "@/components/ui/LineChart";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getTemplateStats } from "@/lib/console/stats";
import { listBucket, type StorageEntry } from "@/lib/console/storage";
import { PROJECT, SERVICES, SECURITY_POSTURE } from "@/lib/console/backend-map";

// Reads request-time identity + live Supabase counts/objects; never prerender.
export const dynamic = "force-dynamic";

const WEEKS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"];

// Placeholder analytics — sample engagement per campaign over the last 8 weeks.
// (MarketingHub does not yet capture send/engagement events; this is a mockup.)
const CAMPAIGNS = [
  { id: "c1", name: "Spring Sale Blast", metric: "Open rate", unit: "%", color: "var(--data-1)", points: [38, 41, 44, 43, 47, 52, 56, 61] },
  { id: "c2", name: "Monthly Newsletter", metric: "Click rate", unit: "%", color: "var(--data-2)", points: [12, 13, 11, 14, 16, 15, 18, 21] },
  { id: "c3", name: "Welcome Series", metric: "Conversions", unit: "", color: "var(--data-3)", points: [5, 8, 9, 12, 14, 19, 23, 27] },
];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const STORAGE_COLUMNS: Column<StorageEntry>[] = [
  {
    key: "name",
    header: "name",
    render: (e) =>
      e.isFolder ? `${e.name}/` : <span className="mono">{e.name}</span>,
  },
  {
    key: "type",
    header: "type",
    width: "140px",
    render: (e) => <Badge>{e.isFolder ? "folder" : (e.mimetype ?? "file")}</Badge>,
  },
  {
    key: "size",
    header: "size",
    mono: true,
    align: "right",
    width: "90px",
    render: (e) => (e.isFolder ? "—" : formatBytes(e.size)),
  },
];

const EXPLORE = [
  { href: "/database", title: "Database", desc: "Rows, schema, and RLS for marketinghub.templates." },
  { href: "/storage", title: "Storage", desc: "The private campaign-templates bucket." },
  { href: "/auth", title: "Authentication", desc: "Cognito + Google SAML and your session." },
  { href: "/api-reference", title: "API", desc: "PostgREST, GraphQL, and Storage endpoints." },
  { href: "/infrastructure", title: "Infrastructure", desc: "Services, backups, and observability." },
];

export default async function OverviewPage() {
  await requireMarketingUser();
  const stats = await getTemplateStats();

  const email = stats.byType.find((t) => t.label === "email")?.count ?? 0;
  const text = stats.byType.find((t) => t.label === "text")?.count ?? 0;

  // Surface storage inline; a failure is shown, never faked away.
  let objects: StorageEntry[] | null = null;
  let storageError = false;
  try {
    objects = await listBucket("");
  } catch {
    storageError = true;
  }
  const folders = objects?.filter((o) => o.isFolder).length ?? 0;
  const files = objects?.filter((o) => !o.isFolder).length ?? 0;
  const totalSize = objects?.reduce((sum, o) => sum + (o.size ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title="Overview"
        subtitle={`${PROJECT.name} · ${PROJECT.bundle} · ${PROJECT.postgres}`}
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
          title="Campaign performance"
          description="Sample data — engagement by campaign over the last 8 weeks. Placeholder until send/engagement events are captured."
        >
          <div className="chart-grid">
            {CAMPAIGNS.map((c) => {
              const current = c.points[c.points.length - 1];
              const delta = current - c.points[0];
              return (
                <div className="surface glint chart-card" key={c.id}>
                  <div className="chart-head">
                    <span className="eyebrow">{c.metric}</span>
                    <span className="chart-title">{c.name}</span>
                    <div className="chart-value-row">
                      <span className="chart-value">
                        {current}
                        {c.unit}
                      </span>
                      <span className="chart-delta">
                        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
                        {c.unit} vs W1
                      </span>
                    </div>
                  </div>
                  <LineChart
                    id={c.id}
                    points={c.points}
                    color={c.color}
                    labels={WEEKS}
                    height={110}
                    ariaLabel={`${c.name} ${c.metric} over 8 weeks`}
                  />
                </div>
              );
            })}
          </div>
        </Section>

        <div className="split-hero">
          <Section
            eyebrow="Object storage"
            title="Storage"
            description="The private campaign-templates bucket."
            actions={<Link href="/storage">Open</Link>}
          >
            {storageError ? (
              <p className="note">Storage listing is currently unavailable.</p>
            ) : (
              <>
                <p className="note">
                  <span className="mono">{folders}</span> folders ·{" "}
                  <span className="mono">{files}</span> files ·{" "}
                  <span className="mono">{formatBytes(totalSize)}</span>
                </p>
                <DataTable
                  columns={STORAGE_COLUMNS}
                  rows={objects ?? []}
                  getRowKey={(e) => e.path}
                  empty="Bucket is empty."
                />
              </>
            )}
          </Section>

          <Section eyebrow="Compute" title="Backend services">
            <p className="note">
              <span className="svc-count">{SERVICES.length}</span> containers · via
              Kong
            </p>
            <div className="svc-list">
              {SERVICES.map((s) => (
                <Badge key={s.name}>{s.name.split(" ")[0]}</Badge>
              ))}
            </div>
          </Section>
        </div>

        <div className="split-2">
          <Section eyebrow="Security" title="Posture">
            <RefList items={SECURITY_POSTURE} />
          </Section>

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
        </div>
      </div>
    </>
  );
}
