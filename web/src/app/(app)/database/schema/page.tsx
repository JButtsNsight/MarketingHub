import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { SchemaTableList } from "@/components/console/SchemaTableList";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { listEditorTables, type EditorTable } from "@/lib/console/tables";
import { listExtensions, type PgExtension } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Schema · MarketingHub",
};

const EXTENSION_COLUMNS: Column<PgExtension>[] = [
  { key: "name", header: "extension", mono: true },
  {
    key: "installed",
    header: "installed",
    width: "120px",
    render: (e) =>
      e.installed_version ? (
        <Badge tone="var(--ok)">{e.installed_version}</Badge>
      ) : (
        <Badge>available</Badge>
      ),
  },
  {
    key: "schema",
    header: "schema",
    mono: true,
    width: "120px",
    render: (e) => e.schema ?? "—",
  },
  { key: "comment", header: "comment", render: (e) => e.comment ?? "—" },
];

/**
 * Live schema browser — everything on this page comes from postgres-meta
 * introspection at request time (tables, columns, PKs, extensions), replacing
 * the old hand-maintained reference. The Table Editor (Rows tab) is where the
 * data itself lives.
 */
export default async function SchemaPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let tables: EditorTable[] | null = null;
  let extensions: PgExtension[] = [];
  try {
    [tables, extensions] = await Promise.all([
      listEditorTables(),
      listExtensions(),
    ]);
  } catch {
    tables = null;
  }

  if (!tables) {
    return (
      <>
        <PageHeader eyebrow="Database" title="Schema" />
        <Tabs items={DB_TABS} />
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      </>
    );
  }

  const schemas = [...new Set(tables.map((t) => t.schema))];
  const installed = extensions.filter((e) => e.installed_version);

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="Schema"
      />
      <Tabs items={DB_TABS} />

      <div className="stack">
        <div className="stat-grid">
          <StatCard label="Tables" value={tables.length} accent="var(--data-1)" />
          <StatCard label="Schemas" value={schemas.length} accent="var(--data-2)" />
          <StatCard
            label="Extensions"
            value={installed.length}
            hint={`${extensions.length} available`}
            accent="var(--data-3)"
          />
        </div>

        {schemas.map((schema) => (
          <Section
            key={schema}
            eyebrow="Schema"
            title={schema}
            description={`${tables.filter((t) => t.schema === schema).length} tables`}
          >
            {/* Client island: pages the table sections 10 at a time (the
                unbounded dimension of this page) with the shared pager. */}
            <SchemaTableList tables={tables.filter((t) => t.schema === schema)} />
          </Section>
        ))}

        <Section
          eyebrow="Postgres"
          title="Extensions"
          description="Installed extensions carry a version badge; the rest are available to enable."
        >
          <DataTable
            columns={EXTENSION_COLUMNS}
            rows={[
              ...installed,
              ...extensions.filter((e) => !e.installed_version),
            ].slice(0, 60)}
            getRowKey={(e) => e.name}
            empty="No extensions reported."
          />
        </Section>
      </div>
    </>
  );
}
