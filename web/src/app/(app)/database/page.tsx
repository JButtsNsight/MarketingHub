import { PageHeader } from "@/components/ui/PageHeader";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listEditorTables } from "@/lib/console/tables";
import { TableEditor } from "@/components/console/TableEditor";
import { Surface } from "@/components/Surface";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Table Editor · MarketingHub",
};

/**
 * The Table Editor (Studio parity): live pg-meta introspection builds the
 * table rail + column metadata server-side; the client island owns browsing,
 * filtering, editing, inserting, and deleting through the group-gated
 * /api/console/rows routes.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function DatabasePage() {
  // Server-side group gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  let tables;
  try {
    tables = await listEditorTables();
  } catch {
    tables = null;
  }

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="Table Editor"
        subtitle="Browse and edit rows across the exposed schemas — structure comes from live introspection (postgres-meta), data moves through the group-gated data API."
      />

      {tables ? (
        <TableEditor initialTables={tables} />
      ) : (
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API. The backend may
            be restarting — refresh in a moment. Row browsing is disabled until
            live table metadata is available.
          </p>
        </Surface>
      )}
    </>
  );
}
