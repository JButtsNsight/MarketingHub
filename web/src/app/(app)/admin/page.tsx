import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList } from "@/components/ui/RefList";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listBucket, type StorageEntry } from "@/lib/console/storage";
import { SERVICES, SECURITY_POSTURE } from "@/lib/console/backend-map";

// Reads request-time identity + live Supabase objects; never prerender.
export const dynamic = "force-dynamic";

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

export default async function AdminPage() {
  await requireMarketingUser();

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
        title="Admin"
      />

      <div className="stack">
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
