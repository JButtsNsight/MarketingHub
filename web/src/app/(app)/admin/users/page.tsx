import { PageHeader } from "@/components/ui/PageHeader";
import { Forbidden } from "@/components/ui/Forbidden";
import { Guide } from "@/components/guide/Guide";
import { UsersRoles } from "@/components/admin/UsersRoles";
import { requireAdminUser } from "@/lib/requireAdminUser";

// Reads request-time identity; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Users & Roles · MarketingHub",
};

/**
 * Users & Roles (Wave D) — the COGNITO surface: pool users with per-user
 * section/god-mode toggle chips backed by /api/console/cognito/*. Distinct
 * from /admin/auth (the read-only GoTrue views); this is where access is
 * actually granted. The gate's user email threads into the client so the UI
 * can disable the own-god-mode chip (the server enforces the same lockout).
 */
export default async function AdminUsersPage() {
  // Server-side admin gate (live pool check): mirrors the API handlers.
  const gate = await requireAdminUser();
  if (!gate.ok) return <Forbidden />;

  return (
    <>
      <Guide id="auth-admin.roles.header">
        <PageHeader title="Users & Roles" />
      </Guide>
      <UsersRoles currentEmail={gate.user.email} />
    </>
  );
}
