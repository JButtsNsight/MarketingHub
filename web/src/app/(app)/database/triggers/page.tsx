import { Guide } from "@/components/guide/Guide";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
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
  // Server-side section gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the platform section.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let triggers;
  try {
    triggers = await listTriggers();
  } catch {
    triggers = null;
  }

  return (
    <>
      <Guide id="db-platform.triggers.header">
        <PageHeader eyebrow="Database" title="Triggers" />
      </Guide>
      <Guide id="db-platform.common.tabs">
        <Tabs items={DB_TABS} />
      </Guide>

      {triggers ? (
        <TriggersClient initialTriggers={triggers} />
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
