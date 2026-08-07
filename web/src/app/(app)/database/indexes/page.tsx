import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { DB_TABS } from "@/lib/console/tabs";
import { listIndexes, OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { listColumns, runQuery } from "@/lib/console/pgmeta";
import { quoteLiteral } from "@/lib/console/identifiers";
import {
  IndexesClient,
  type IndexRow,
  type IndexTableDto,
} from "@/components/console/IndexesClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Indexes · MarketingHub",
};

/**
 * The foundation `listIndexes` (schema/table/name/unique/primary/definition/
 * bytes) enriched with `idx_scan` from pg_stat_user_indexes — the same shape
 * the /api/console/indexes GET returns, so the client can refresh in place.
 */
async function loadIndexes(): Promise<IndexRow[]> {
  const schemaList = OBJECT_SCHEMAS.map((s) => quoteLiteral(s)).join(", ");
  const [indexes, statRows] = await Promise.all([
    listIndexes(OBJECT_SCHEMAS),
    runQuery(
      `select schemaname as schema,
              relname as "table",
              indexrelname as name,
              coalesce(idx_scan, 0)::int8 as idx_scan
         from pg_catalog.pg_stat_user_indexes
        where schemaname in (${schemaList})`,
    ),
  ]);
  const scans = new Map<string, number>();
  for (const r of statRows) {
    scans.set(`${r.schema}.${r.table}.${r.name}`, Number(r.idx_scan ?? 0));
  }
  return indexes.map((ix) => ({
    schema: ix.schema,
    table: ix.table,
    name: ix.name,
    isUnique: ix.isUnique,
    isPrimary: ix.isPrimary,
    definition: ix.definition,
    bytes: ix.bytes,
    idxScan: scans.get(`${ix.schema}.${ix.table}.${ix.name}`) ?? 0,
  }));
}

/** Table → column-name list for the managed schemas, for the create form. */
async function loadIndexTables(): Promise<IndexTableDto[]> {
  const cols = await listColumns(OBJECT_SCHEMAS);
  const byTable = new Map<string, IndexTableDto>();
  for (const c of cols) {
    const key = `${c.schema}.${c.table}`;
    let entry = byTable.get(key);
    if (!entry) {
      entry = { schema: c.schema, table: c.table, columns: [] };
      byTable.set(key, entry);
    }
    entry.columns.push(c.name);
  }
  return [...byTable.values()].sort((a, b) =>
    `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`),
  );
}

/**
 * Indexes (Studio Database → Indexes): live index inventory with sizes and
 * scan-counts, plus create/drop. The server gate mirrors the API handlers;
 * introspection failure degrades to an explicit card, never a blank console.
 */
export default async function IndexesPage() {
  await requireMarketingUser();

  let indexes: IndexRow[] | null = null;
  let tables: IndexTableDto[] = [];
  try {
    [indexes, tables] = await Promise.all([loadIndexes(), loadIndexTables()]);
  } catch {
    indexes = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Indexes" />
      <Tabs items={DB_TABS} />

      {indexes ? (
        <IndexesClient initialIndexes={indexes} tables={tables} />
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
