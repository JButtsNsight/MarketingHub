import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Forbidden } from "@/components/ui/Forbidden";
import { AUTH_TABS } from "@/lib/console/tabs";
import { requireAdminUser } from "@/lib/requireAdminUser";
import { ImpersonateClient } from "./ImpersonateClient";

// Reads request-time identity; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "User Impersonation · MarketingHub",
};

/**
 * User Impersonation (Studio's "what can this identity see" panel). Mints a
 * bounded `authenticated`-role JWT server-side, runs one select as that
 * identity and the same select as service_role, and shows both result sets.
 * Every mint+query is audited; the raw JWT never reaches the browser.
 */
export default async function ImpersonatePage() {
  // Server-side admin gate: mirrors the API handler.
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;

  return (
    <>
      <PageHeader title="User impersonation" />
      <Tabs items={AUTH_TABS} />
      <ImpersonateClient />
    </>
  );
}
