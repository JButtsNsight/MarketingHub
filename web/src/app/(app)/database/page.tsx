import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { categoryColorVar } from "@/components/templates/categoryColor";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listTemplateRows } from "@/lib/console/db";
import { DB_TABS } from "@/lib/console/tabs";
import type { Template } from "@/lib/templates/schema";

export const dynamic = "force-dynamic";

const COLUMNS: Column<Template>[] = [
  {
    key: "id",
    header: "id",
    mono: true,
    width: "110px",
    render: (r) => <span title={r.id}>{r.id.slice(0, 8)}…</span>,
  },
  {
    key: "name",
    header: "name",
    render: (r) => <Link href={`/templates/${r.id}`}>{r.name}</Link>,
  },
  {
    key: "type",
    header: "type",
    width: "84px",
    render: (r) => <Badge>{r.type}</Badge>,
  },
  {
    key: "category",
    header: "category",
    width: "150px",
    render: (r) => (
      <Badge tone={categoryColorVar(r.category)}>{r.category}</Badge>
    ),
  },
  { key: "created_by", header: "created_by", mono: true },
  {
    key: "created_at",
    header: "created_at",
    mono: true,
    width: "116px",
    render: (r) => r.created_at.slice(0, 10),
  },
  {
    key: "storage_path",
    header: "file",
    mono: true,
    width: "70px",
    render: (r) => (r.storage_path ? "yes" : "—"),
  },
];

export default async function DatabaseRowsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireMarketingUser();
  const sp = await searchParams;
  const requested = Number.parseInt(sp.page ?? "1", 10);
  const { rows, total, page, pageCount } = await listTemplateRows(
    Number.isFinite(requested) ? requested : 1,
  );

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="marketinghub.templates"
        subtitle="Rows read via the service-role data API (PostgREST)."
        count={`${total} rows`}
      />
      <Tabs items={DB_TABS} />

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(r) => r.id}
        empty="No templates yet — add one from the Templates section."
      />

      <div className="pager">
        <span className="pager-info">
          page {page} of {pageCount}
        </span>
        {page > 1 ? (
          <Link className="pager-link" href={`/database?page=${page - 1}`}>
            Previous
          </Link>
        ) : (
          <span className="pager-link" aria-disabled="true">
            Previous
          </span>
        )}
        {page < pageCount ? (
          <Link className="pager-link" href={`/database?page=${page + 1}`}>
            Next
          </Link>
        ) : (
          <span className="pager-link" aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </>
  );
}
