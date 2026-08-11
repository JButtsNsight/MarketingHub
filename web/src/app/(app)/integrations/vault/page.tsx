import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
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
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let secrets: VaultSecretMeta[] | null = null;
  try {
    secrets = await listSecrets();
  } catch {
    secrets = null;
  }

  if (!secrets) {
    return (
      <>
        <PageHeader title="Vault" />
        <Tabs items={INTEGRATION_TABS} />
        <Surface className="empty-state" glint>
          <h2>Vault unreachable</h2>
          <p>
            vault.secrets did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Vault" />
      <Tabs items={INTEGRATION_TABS} />
      <VaultClient initialSecrets={secrets} />
    </>
  );
}
