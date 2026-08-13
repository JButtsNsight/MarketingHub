import { Guide } from "@/components/guide/Guide";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { quoteLiteral } from "@/lib/console/identifiers";
import { listTables, runQuery } from "@/lib/console/pgmeta";
import { listWebhooks, WEBHOOKS_ADMIN_ROLE } from "@/lib/console/webhooks";
import { DB_TABS } from "@/lib/console/tabs";
import {
  WebhooksClient,
  type TableRefDto,
  type WebhookDto,
} from "@/components/console/WebhooksClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Webhooks · MarketingHub",
};

/**
 * Database Webhooks (Studio parity): live introspection builds the webhook list
 * (triggers whose function is supabase_functions.http_request), the table list
 * for the create picker, and a readiness flag (does the `webhooks_admin` role
 * exist — i.e. has cdk/sql/2026-08-07-scope-pg-net.sql been applied). The
 * client island owns create/drop through the group-gated /api/console/webhooks
 * route. Introspection failure degrades to an explicit error card.
 */
export default async function WebhooksPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let data: {
    webhooks: WebhookDto[];
    availableTables: TableRefDto[];
    ready: boolean;
  } | null = null;

  try {
    const [webhooks, tables, readyRows] = await Promise.all([
      listWebhooks(),
      listTables(OBJECT_SCHEMAS),
      runQuery(
        `select exists(
           select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(WEBHOOKS_ADMIN_ROLE)}
         ) as ready`,
      ),
    ]);

    data = {
      webhooks,
      availableTables: tables
        .map((t) => ({ schema: t.schema, name: t.name }))
        .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)),
      ready: readyRows[0]?.ready === true,
    };
  } catch {
    data = null;
  }

  return (
    <>
      <Guide id="db-platform.webhooks.header">
        <PageHeader eyebrow="Database" title="Webhooks" />
      </Guide>
      <Guide id="db-platform.common.tabs">
        <Tabs items={DB_TABS} />
      </Guide>

      {data ? (
        <WebhooksClient
          initialWebhooks={data.webhooks}
          availableTables={data.availableTables}
          ready={data.ready}
        />
      ) : (
        <Guide id="db-platform.common.introspection-unavailable">
          <Surface className="empty-state" glint>
            <h2>Introspection unavailable</h2>
            <p>
              postgres-meta did not answer through the data API — refresh in a
              moment.
            </p>
          </Surface>
        </Guide>
      )}
    </>
  );
}
