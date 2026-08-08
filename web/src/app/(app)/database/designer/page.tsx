import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { DB_TABS } from "@/lib/console/tabs";
import { OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { listColumns, listTables } from "@/lib/console/pgmeta";
import {
  SchemaDesignerCanvas,
  type DesignerColumn,
  type DesignerEdge,
  type DesignerTable,
} from "@/components/console/SchemaDesignerCanvas";

/** Local copy of the client's key helper — importing a runtime value from a
 * "use client" module into a server component would yield a non-callable
 * client reference, so this must stay server-side. */
function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Designer · MarketingHub",
};

/**
 * Assemble the read-only ER model from pg-meta introspection: table cards with
 * their columns (PK/FK flagged), plus a de-duplicated foreign-key edge list.
 * Relationships come off each PgTable.relationships (both directions), so we
 * dedupe by constraint name and keep only edges whose BOTH ends are visible in
 * the managed schemas — no cross-schema dangling lines.
 */
async function loadModel(): Promise<{
  tables: DesignerTable[];
  edges: DesignerEdge[];
}> {
  const [pgTables, pgColumns] = await Promise.all([
    listTables(OBJECT_SCHEMAS),
    listColumns(OBJECT_SCHEMAS),
  ]);

  const visible = new Set(pgTables.map((t) => tableKey(t.schema, t.name)));

  // Dedupe FK edges by constraint name; drop any end outside the managed set.
  const fkColumns = new Map<string, Set<string>>(); // tableKey -> {fk col names}
  const edgeMap = new Map<string, DesignerEdge>();
  for (const t of pgTables) {
    for (const r of (t.relationships ?? [])) {
      const srcKey = tableKey(r.source_schema, r.source_table_name);
      const tgtKey = tableKey(r.target_table_schema, r.target_table_name);
      if (!visible.has(srcKey) || !visible.has(tgtKey)) continue;
      if (!fkColumns.has(srcKey)) fkColumns.set(srcKey, new Set());
      fkColumns.get(srcKey)!.add(r.source_column_name);
      if (!edgeMap.has(r.constraint_name)) {
        edgeMap.set(r.constraint_name, {
          id: r.constraint_name,
          sourceSchema: r.source_schema,
          sourceTable: r.source_table_name,
          sourceColumn: r.source_column_name,
          targetSchema: r.target_table_schema,
          targetTable: r.target_table_name,
          targetColumn: r.target_column_name,
        });
      }
    }
  }

  // Primary-key column names per table.
  const pkColumns = new Map<string, Set<string>>();
  for (const t of pgTables) {
    const key = tableKey(t.schema, t.name);
    pkColumns.set(key, new Set(t.primary_keys.map((pk) => pk.name)));
  }

  // Columns grouped per table, in ordinal order.
  const columnsByTable = new Map<string, DesignerColumn[]>();
  const ordered = [...pgColumns].sort(
    (a, b) => a.ordinal_position - b.ordinal_position,
  );
  for (const c of ordered) {
    const key = tableKey(c.schema, c.table);
    if (!visible.has(key)) continue;
    const pk = pkColumns.get(key)?.has(c.name) ?? false;
    const fk = fkColumns.get(key)?.has(c.name) ?? false;
    const col: DesignerColumn = {
      name: c.name,
      dataType: c.format || c.data_type,
      isPrimaryKey: pk,
      isForeignKey: fk,
      isNullable: c.is_nullable,
    };
    const list = columnsByTable.get(key);
    if (list) list.push(col);
    else columnsByTable.set(key, [col]);
  }

  const tables: DesignerTable[] = pgTables
    .map((t) => ({
      schema: t.schema,
      name: t.name,
      rowsEstimate: t.live_rows_estimate,
      columns: columnsByTable.get(tableKey(t.schema, t.name)) ?? [],
    }))
    .sort((a, b) =>
      tableKey(a.schema, a.name).localeCompare(tableKey(b.schema, b.name)),
    );

  return { tables, edges: [...edgeMap.values()] };
}

/**
 * Visual Schema Designer (Studio Database → Schema Visualizer). Render-first,
 * read-only ER canvas over the managed schemas. The server gate mirrors the
 * API handlers; introspection failure degrades to an explicit card rather than
 * a blank canvas. There is no write path on this surface, so no confirm layer
 * is needed — reads are ungated by design.
 */
export default async function SchemaDesignerPage() {
  await requireMarketingUser();

  let model: { tables: DesignerTable[]; edges: DesignerEdge[] } | null = null;
  try {
    model = await loadModel();
  } catch {
    model = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Designer" />
      <Tabs items={DB_TABS} />

      {model ? (
        <SchemaDesignerCanvas tables={model.tables} edges={model.edges} />
      ) : (
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      )}
    </>
  );
}
