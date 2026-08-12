import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { listInstalledExtensions } from "@/lib/console/dbobjects";
import type { PgExtension } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";
import {
  ExtensionsClient,
  type ExtensionDto,
} from "@/components/console/ExtensionsClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Extensions · MarketingHub",
};

/**
 * Live Postgres extensions — pg_available_extensions joined to installed state
 * (pg_extension) through postgres-meta. Enable/drop are DDL run as superuser
 * and live in the client component behind an interrupting confirm; this server
 * page only gates on the platform section and hands down the initial list.
 */
export default async function ExtensionsPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let extensions: PgExtension[] | null = null;
  try {
    extensions = await listInstalledExtensions();
  } catch {
    extensions = null;
  }

  if (!extensions) {
    return (
      <>
        <PageHeader eyebrow="Database" title="Extensions" />
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

  const installed = extensions.filter((e) => e.installed_version);

  return (
    <>
      <PageHeader eyebrow="Database" title="Extensions" />
      <Tabs items={DB_TABS} />

      <div className="stack">
        <div className="stat-grid">
          <StatCard
            label="Installed"
            value={installed.length}
            accent="var(--data-3)"
          />
          <StatCard
            label="Available"
            value={extensions.length - installed.length}
            accent="var(--data-2)"
          />
          <StatCard label="Total" value={extensions.length} accent="var(--data-1)" />
        </div>

        <Section
          eyebrow="Postgres"
          title="Extensions"
          description="Installed extensions carry a version badge; the rest are available to enable."
        >
          <ExtensionsClient initialExtensions={extensions as ExtensionDto[]} />
        </Section>
      </div>
    </>
  );
}
