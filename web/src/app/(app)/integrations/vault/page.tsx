import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { requireSectionUser } from "@/lib/requireSection";
import { listSecrets, type VaultSecretMeta } from "@/lib/console/vault";
import { VaultClient } from "@/components/console/VaultClient";

// Reads request-time identity + live vault metadata; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vault · MarketingHub",
};

// The Integrations section, local to this surface (each integrations page
// carries its own copy — the shared tabs module owns only the Database
// section). Cron/Queues predate Vault here.
const INTEGRATION_TABS: TabItem[] = [
  { href: "/integrations/cron", label: "Cron" },
  { href: "/integrations/queues", label: "Queues" },
  { href: "/integrations/vault", label: "Vault" },
];

/**
 * The Vault integration screen (Studio → Integrations → Vault): supabase_vault
 * secrets as a METADATA-ONLY list, with create/edit/delete and the audited
 * per-secret reveal in the client component. The server render never touches a
 * decrypted value — `listSecrets` reads metadata columns from vault.secrets
 * only, so no plaintext can be serialized into the page payload.
 */
export default async function VaultPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let secrets: VaultSecretMeta[] | null = null;
  try {
    secrets = await listSecrets();
  } catch {
    secrets = null;
  }

  if (!secrets) {
    return (
      <>
        <Guide id="integrations.vault.page">
          <PageHeader title="Vault" />
        </Guide>
        <Guide id="integrations.section.tabs">
          <Tabs items={INTEGRATION_TABS} />
        </Guide>
        <Guide id="integrations.vault.unreachable">
          <Surface className="empty-state" glint>
            <h2>Vault unreachable</h2>
            <p>
              vault.secrets did not answer through the data API — refresh in a
              moment.
            </p>
          </Surface>
        </Guide>
      </>
    );
  }

  return (
    <>
      <Guide id="integrations.vault.page">
        <PageHeader title="Vault" />
      </Guide>
      <Guide id="integrations.section.tabs">
        <Tabs items={INTEGRATION_TABS} />
      </Guide>
      <VaultClient initialSecrets={secrets} />
    </>
  );
}
