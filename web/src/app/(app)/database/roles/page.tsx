import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listRoles } from "@/lib/console/dbobjects";
import { runQuery } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";
import { RolesClient, type RoleMembership } from "@/components/console/RolesClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Roles · MarketingHub",
};

/**
 * Read pg_auth_members for the initial server render. The foundation lib
 * (dbobjects) exposes roles read-only via listRoles() but has no membership
 * reader, so this is a static, parameter-free SELECT run through runQuery — no
 * user input reaches SQL. /api/console/roles carries the twin used by the
 * client's refresh after a mutation.
 */
async function listRoleMemberships(): Promise<RoleMembership[]> {
  const rows = await runQuery(
    `select g.rolname as role,
            m.rolname as member,
            am.admin_option as admin_option,
            gr.rolname as grantor
       from pg_catalog.pg_auth_members am
       join pg_catalog.pg_roles g on g.oid = am.roleid
       join pg_catalog.pg_roles m on m.oid = am.member
       left join pg_catalog.pg_roles gr on gr.oid = am.grantor
      order by g.rolname, m.rolname`,
  );
  return rows.map((r) => ({
    role: String(r.role),
    member: String(r.member),
    adminOption: r.admin_option === true,
    grantor: r.grantor == null ? null : String(r.grantor),
  }));
}

/**
 * Database → Roles (Studio parity): live pg_roles + pg_auth_members
 * introspection rendered server-side; the client island owns the three guarded
 * writes (create / alter / drop role) through the group-gated
 * /api/console/roles route.
 *
 * Introspection failure (pg-meta unreachable) degrades to an explicit error
 * card — never a blank console.
 */
export default async function RolesPage() {
  // Server-side group gate: mirrors the API handlers so this page can't be
  // browsed by an authenticated employee outside the `marketing` group.
  await requireMarketingUser();

  let data: { roles: Awaited<ReturnType<typeof listRoles>>; memberships: RoleMembership[] } | null;
  try {
    const [roles, memberships] = await Promise.all([
      listRoles(),
      listRoleMemberships(),
    ]);
    data = { roles, memberships };
  } catch {
    data = null;
  }

  return (
    <>
      <PageHeader eyebrow="Database" title="Roles" />
      <Tabs items={DB_TABS} />

      {data ? (
        <RolesClient
          initialRoles={data.roles}
          initialMemberships={data.memberships}
        />
      ) : (
        <Surface className="empty-state" glint>
          <h2>Introspection unavailable</h2>
          <p>
            postgres-meta did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      )}
    </>
  );
}
