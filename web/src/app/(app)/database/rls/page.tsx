import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import { listEditorTables } from "@/lib/console/tables";
import { listPolicies, POLICY_TEMPLATES } from "@/lib/console/policies";
import { DB_TABS } from "@/lib/console/tabs";
import { Guide } from "@/components/guide/Guide";
import {
  PoliciesClient,
  type PolicyDto,
  type PolicyTableDto,
  type PolicyTemplateDto,
  type PolicyTemplatePrefill,
} from "@/components/console/PoliciesClient";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "RLS · MarketingHub",
};

/** The PostgREST-exposed schemas the console manages policies for. */
const POLICY_SCHEMAS = ["marketinghub", "public", "storage"];

/**
 * Structured create-form prefill for each POLICY_TEMPLATE. The template bodies
 * in the foundation lib are raw SQL (they also enable RLS); here we mirror the
 * policy each one creates as editable form fields so picking a template fills
 * in name / command / action / roles / using / check. The user then chooses the
 * table and submits through createPolicy — the same validated path as any other
 * create.
 */
const TEMPLATE_PREFILL: Record<string, PolicyTemplatePrefill> = {
  service_role_full_access: {
    name: "service_role_full_access",
    command: "ALL",
    action: "PERMISSIVE",
    roles: "service_role",
    using: "true",
    check: "true",
  },
  owner_access_auth_uid: {
    name: "owner_access",
    command: "ALL",
    action: "PERMISSIVE",
    roles: "authenticated",
    using: "(select auth.uid()) = user_id",
    check: "(select auth.uid()) = user_id",
  },
  public_read_only: {
    name: "public_read_only",
    command: "SELECT",
    action: "PERMISSIVE",
    roles: "anon, authenticated",
    using: "true",
    check: "",
  },
};

const EMPTY_PREFILL: PolicyTemplatePrefill = {
  name: "",
  command: "ALL",
  action: "PERMISSIVE",
  roles: "",
  using: "",
  check: "",
};

/**
 * Policies (Studio → Auth → Policies): live pg-meta introspection builds the
 * per-table RLS state and the policy list server-side, then the client island
 * owns create / alter / drop and the template picker through the group-gated
 * /api/console/policies routes.
 *
 * The house doctrine: every exposed table is deny-by-default for anon/
 * authenticated; the app path is service_role (BYPASSRLS) behind the Cognito
 * section gate. Introspection failure degrades to an explicit error card.
 */
export default async function RlsPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let data: { tables: PolicyTableDto[]; policies: PolicyDto[] } | null = null;
  try {
    const [tables, policies] = await Promise.all([
      listEditorTables(),
      listPolicies(POLICY_SCHEMAS),
    ]);
    data = {
      tables: tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        rlsEnabled: t.rlsEnabled,
      })),
      policies,
    };
  } catch {
    data = null;
  }

  const templates: PolicyTemplateDto[] = POLICY_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    prefill: TEMPLATE_PREFILL[t.id] ?? EMPTY_PREFILL,
  }));

  return (
    <>
      <Guide id="database.rls.page">
        <PageHeader eyebrow="Database" title="Policies" />
      </Guide>
      <Guide id="database.section.tabs">
        <Tabs items={DB_TABS} />
      </Guide>

      {data ? (
        <PoliciesClient
          initialTables={data.tables}
          initialPolicies={data.policies}
          templates={templates}
        />
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
