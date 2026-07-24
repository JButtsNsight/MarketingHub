import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listBucket, CAMPAIGN_BUCKET, type StorageEntry } from "@/lib/console/storage";

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

interface Crumb {
  label: string;
  prefix: string;
}

function crumbs(prefix: string): Crumb[] {
  const segments = prefix ? prefix.split("/").filter(Boolean) : [];
  const out: Crumb[] = [{ label: CAMPAIGN_BUCKET, prefix: "" }];
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    out.push({ label: seg, prefix: acc });
  }
  return out;
}

export default async function StoragePage({
  searchParams,
}: {
  searchParams: Promise<{ prefix?: string }>;
}) {
  await requireMarketingUser();
  const sp = await searchParams;
  const prefix = (sp.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const entries = await listBucket(prefix);

  const columns: Column<StorageEntry>[] = [
    {
      key: "name",
      header: "name",
      render: (e) =>
        e.isFolder ? (
          <Link href={`/storage?prefix=${encodeURIComponent(e.path)}`}>
            {e.name}/
          </Link>
        ) : (
          <span className="mono">{e.name}</span>
        ),
    },
    {
      key: "type",
      header: "type",
      width: "140px",
      render: (e) => (
        <Badge>{e.isFolder ? "folder" : (e.mimetype ?? "file")}</Badge>
      ),
    },
    {
      key: "size",
      header: "size",
      mono: true,
      align: "right",
      width: "90px",
      render: (e) => (e.isFolder ? "—" : formatBytes(e.size)),
    },
    {
      key: "updatedAt",
      header: "updated",
      mono: true,
      width: "116px",
      render: (e) => (e.updatedAt ? e.updatedAt.slice(0, 10) : "—"),
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "110px",
      render: (e) =>
        e.isFolder ? null : (
          <a
            href={`/api/console/storage/download?path=${encodeURIComponent(e.path)}`}
          >
            Download
          </a>
        ),
    },
  ];

  const trail = crumbs(prefix);

  return (
    <>
      <PageHeader
        eyebrow="Storage"
        title="campaign-templates"
        subtitle="Private bucket — objects are proxied through the console via short-lived signed URLs."
        count={`${entries.length} items`}
      />

      <nav className="tabs" aria-label="Breadcrumb">
        {trail.map((c, i) => (
          <Link
            key={i}
            href={`/storage?prefix=${encodeURIComponent(c.prefix)}`}
            className={i === trail.length - 1 ? "tab on" : "tab"}
          >
            {c.label}
          </Link>
        ))}
      </nav>

      <DataTable
        columns={columns}
        rows={entries}
        getRowKey={(e) => e.path}
        empty="This location is empty."
      />
    </>
  );
}
