import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listEnumTypes, OBJECT_SCHEMAS, type PgEnumType } from "@/lib/console/dbobjects";
import { DB_TABS } from "@/lib/console/tabs";
import { TypesClient } from "@/components/console/TypesClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Types · MarketingHub",
};

/**
 * Enumerated Types (Studio → Database → Enumerated Types). Live `pg_type` /
 * `pg_enum` introspection for the surfaced user schemas is fetched server-side;
 * the client island owns create / add-value / drop, each behind the confirm
 * modal, through the group-gated /api/console/types routes.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function TypesPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let types: PgEnumType[] | null = null;
  try {
    types = await listEnumTypes();
  } catch {
    types = null;
  }

  if (!types) {
    return (
      <>
        <PageHeader eyebrow="Database" title="Types" />
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

  return (
    <>
      <PageHeader eyebrow="Database" title="Types" />
      <Tabs items={DB_TABS} />
      <TypesClient initialTypes={types} schemas={OBJECT_SCHEMAS} />
    </>
  );
}
