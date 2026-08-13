import { PageHeader } from "@/components/ui/PageHeader";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { listEditorTables } from "@/lib/console/tables";
import { TableEditor } from "@/components/console/TableEditor";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";

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
  // Server-side section gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the platform section.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let tables;
  try {
    tables = await listEditorTables();
  } catch {
    tables = null;
  }

  return (
    <>
      <Guide id="database.editor.page">
        <PageHeader
          eyebrow="Database"
          title="Table Editor"
        />
      </Guide>

      {tables ? (
        <TableEditor initialTables={tables} />
      ) : (
        <Guide id="database.section.introspection-missing">
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
