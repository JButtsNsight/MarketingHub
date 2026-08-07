import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listPublications, OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { listTables, runQuery } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";
import {
  PublicationsClient,
  type PublicationDto,
  type TableRefDto,
} from "@/components/console/PublicationsClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Publications · MarketingHub",
};

/**
 * Publications (Studio parity): live pg-meta introspection builds the
 * publication list (pg_publication) plus member tables (pg_publication_tables)
 * and the table list for the create/alter pickers server-side; the client
 * island owns create/alter/drop through the group-gated
 * /api/console/publications routes.
 *
 * The foundation `dbobjects` module ships list + drop only, so member tables
 * and the available-table list are read here directly (same superuser path,
 * same server gate). Introspection failure degrades to an explicit error card.
 */
export default async function PublicationsPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let data: {
    publications: PublicationDto[];
    availableTables: TableRefDto[];
  } | null = null;

  try {
    const [pubs, tableRows, tables] = await Promise.all([
      listPublications(),
      runQuery(
        `select pubname, schemaname, tablename
           from pg_catalog.pg_publication_tables
          order by pubname, schemaname, tablename`,
      ),
      listTables(OBJECT_SCHEMAS),
    ]);

    const memberTables = new Map<string, string[]>();
    for (const r of tableRows) {
      const pub = String(r.pubname);
      const arr = memberTables.get(pub) ?? [];
      arr.push(`${String(r.schemaname)}.${String(r.tablename)}`);
      memberTables.set(pub, arr);
    }

    data = {
      publications: pubs.map((p) => ({
        ...p,
        tables: p.allTables ? [] : (memberTables.get(p.name) ?? []),
      })),
      availableTables: tables
        .map((t) => ({ schema: t.schema, name: t.name }))
        .sort((a, b) =>
          `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
        ),
    };
  } catch {
    data = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Publications" />
      <Tabs items={DB_TABS} />

      {data ? (
        <PublicationsClient
          initialPublications={data.publications}
          availableTables={data.availableTables}
        />
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
