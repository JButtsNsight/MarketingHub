import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listEditorTables, type EditorColumn, type EditorTable } from "@/lib/console/tables";
import { listExtensions, type PgExtension } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Schema · MarketingHub",
};

const COLUMN_COLUMNS: Column<EditorColumn>[] = [
  {
    key: "name",
    header: "column",
    mono: true,
    render: (c) => (
      <>
        {c.name}{" "}
        {c.isPrimaryKey ? <Badge tone="var(--data-1)">PK</Badge> : null}
      </>
    ),
  },
  { key: "dataType", header: "type", mono: true, width: "220px", render: (c) => c.dataType },
  {
    key: "nullable",
    header: "nullable",
    width: "90px",
    render: (c) => (c.isNullable ? "yes" : "no"),
  },
  {
    key: "default",
    header: "default",
    mono: true,
    render: (c) =>
      c.defaultValue ? (
        <span title={c.defaultValue}>
          {c.defaultValue.length > 48
            ? `${c.defaultValue.slice(0, 47)}…`
            : c.defaultValue}
        </span>
      ) : (
        "—"
      ),
  },
];

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
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

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
        <PageHeader eyebrow="Build" title="Schema" />
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
        eyebrow="Build"
        title="Schema"
        subtitle="Live structure from postgres-meta — tables, columns, primary keys, and extensions, introspected at request time."
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
            <div className="stack">
              {tables
                .filter((t) => t.schema === schema)
                .map((t) => (
                  <div key={`${t.schema}.${t.name}`}>
                    <p className="eyebrow">
                      {t.name}{" "}
                      <span className="mono">
                        · {t.rowsEstimate.toLocaleString()} rows · {t.size}
                      </span>
                    </p>
                    <DataTable
                      columns={COLUMN_COLUMNS}
                      rows={t.columns}
                      getRowKey={(c) => c.name}
                      empty="No columns."
                    />
                  </div>
                ))}
            </div>
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
