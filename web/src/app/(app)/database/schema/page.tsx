import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { DB_TABS } from "@/lib/console/tabs";
import {
  TEMPLATES_TABLE,
  EXPOSED_SCHEMAS,
  EXTENSIONS,
  STOCK_SCHEMAS,
  type ColumnInfo,
} from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

const COLUMN_COLUMNS: Column<ColumnInfo>[] = [
  { key: "name", header: "column", mono: true, width: "18%" },
  { key: "type", header: "type", mono: true, width: "16%" },
  {
    key: "nullable",
    header: "nullable",
    width: "90px",
    render: (c) => (c.nullable ? "yes" : "no"),
  },
  {
    key: "default",
    header: "default",
    mono: true,
    width: "18%",
    render: (c) => c.default ?? "—",
  },
  { key: "note", header: "note", render: (c) => c.note ?? "—" },
];

type StockSchema = (typeof STOCK_SCHEMAS)[number];
const STOCK_COLUMNS: Column<StockSchema>[] = [
  { key: "name", header: "schema", mono: true, width: "18%" },
  { key: "note", header: "notes" },
];

export default async function DatabaseSchemaPage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="marketinghub.templates"
        subtitle={TEMPLATES_TABLE.purpose}
      />
      <Tabs items={DB_TABS} />

      <div className="stack">
        <Section eyebrow="Table" title="Columns">
          <DataTable
            columns={COLUMN_COLUMNS}
            rows={TEMPLATES_TABLE.columns}
            getRowKey={(c) => c.name}
          />
        </Section>

        <Section
          eyebrow="API"
          title="Exposed schemas"
          description="Schemas PostgREST serves through Kong. Cross-schema reads set the Accept-Profile header."
        >
          <div className="filter-group">
            {EXPOSED_SCHEMAS.map((s) => (
              <Badge key={s} tone="var(--data-3)">
                {s}
              </Badge>
            ))}
          </div>
          <DataTable
            columns={STOCK_COLUMNS}
            rows={STOCK_SCHEMAS as unknown as StockSchema[]}
            getRowKey={(s) => s.name}
          />
        </Section>

        <Section
          eyebrow="Postgres"
          title="Extensions"
          description="Installed extensions (pg_net is locked down — EXECUTE revoked from app roles)."
        >
          <div className="filter-group">
            {EXTENSIONS.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </div>
        </Section>
      </div>
    </>
  );
}
