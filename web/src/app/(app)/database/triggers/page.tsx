import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listTriggers } from "@/lib/console/dbobjects";
import { DB_TABS } from "@/lib/console/tabs";
import { TriggersClient } from "@/components/console/TriggersClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Triggers · MarketingHub",
};

/**
 * Database → Triggers (Studio parity): live pg_trigger introspection for the
 * user schemas, rendered server-side; the client island owns the two guarded
 * writes (enable/disable and drop) through the group-gated
 * /api/console/triggers route.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function TriggersPage() {
  // Server-side group gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  let triggers;
  try {
    triggers = await listTriggers();
  } catch {
    triggers = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Triggers" />
      <Tabs items={DB_TABS} />

      {triggers ? (
        <TriggersClient initialTriggers={triggers} />
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
