import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listApiDocEntries, type ApiDocEntry } from "@/lib/console/apidocs";
import { ApiDocsClient } from "@/components/console/ApiDocsClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data API · MarketingHub",
};

/**
 * API → Data API (Studio "API Docs" parity). Per-table PostgREST, supabase-js,
 * and GraphQL examples generated from live pg-meta introspection. Entirely
 * read-only: the page gate mirrors the API handlers (requireMarketingUser),
 * and there is no mutation path so no write confirm is needed.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function ApiReferencePage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let entries: ApiDocEntry[] | null = null;
  try {
    entries = await listApiDocEntries();
  } catch {
    entries = null;
  }

  return (
    <>
      <PageHeader eyebrow="API" title="Data API" />

      <div className="stack">
        <Section eyebrow="Access" title="Private data API">
          <p className="ref-note">
            <Badge>note</Badge>
            <span>
              The data API is private — examples print placeholders, never a
              real secret.
            </span>
          </p>
        </Section>

        {entries ? (
          <ApiDocsClient entries={entries} />
        ) : (
          <Surface className="empty-state" glint>
            <h2>Introspection unavailable</h2>
            <p>
              postgres-meta did not answer through the data API — refresh in a
              moment.
            </p>
          </Surface>
        )}
      </div>
    </>
  );
}
