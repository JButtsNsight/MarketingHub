import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Forbidden } from "@/components/ui/Forbidden";
import { AuthUsersClient } from "@/components/console/AuthUsersClient";
import { Guide } from "@/components/guide/Guide";
import { AUTH_TABS } from "@/lib/console/tabs";
import { requireAdminUser } from "@/lib/requireAdminUser";

// Reads request-time identity; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Auth Users · MarketingHub",
};

/**
 * GoTrue Users (Studio's Authentication → Users, Wave 3-partial). READ-ONLY
 * BY DESIGN — the wave's hard constraint: list + detail views only, zero
 * mutation affordances (no invite/ban/delete, nothing that writes). App
 * identity is Cognito/SAML today, so the honest baseline here is an empty
 * GoTrue store until the Wave-3 SAML cutover (external deliverable pending).
 */
export default async function AuthUsersPage() {
  // Server-side admin gate: mirrors the API handler.
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;

  return (
    <>
      <Guide id="auth-admin.users.header">
        <PageHeader title="Users" />
      </Guide>
      <Guide id="auth-admin.auth.tabs">
        <Tabs items={AUTH_TABS} />
      </Guide>
      <AuthUsersClient />
    </>
  );
}
