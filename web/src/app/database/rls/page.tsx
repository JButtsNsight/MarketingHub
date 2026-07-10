import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { DB_TABS } from "@/lib/console/tabs";
import { TEMPLATES_TABLE, type PolicyInfo } from "@/lib/console/backend-map";

export const dynamic = "force-dynamic";

const POLICY_COLUMNS: Column<PolicyInfo>[] = [
  { key: "name", header: "policy", mono: true, width: "22%" },
  {
    key: "kind",
    header: "kind",
    width: "120px",
    render: (p) => <Badge>{p.kind}</Badge>,
  },
  { key: "command", header: "command", mono: true, width: "90px" },
  { key: "roles", header: "roles", mono: true },
  { key: "using", header: "using", mono: true, width: "80px" },
  { key: "check", header: "with check", mono: true, width: "90px" },
];

export default async function DatabaseRlsPage() {
  await requireMarketingUser();

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="Row Level Security"
        subtitle="marketinghub.templates — deny-by-default, service-role only."
      />
      <Tabs items={DB_TABS} />

      <div className="stack">
        <Section eyebrow="Table" title="RLS status">
          <p className="note">{TEMPLATES_TABLE.rls}</p>
        </Section>

        <Section
          eyebrow="Policies"
          title="Policies on marketinghub.templates"
          description="A single restrictive deny-all policy for anon + authenticated; the service_role (BYPASSRLS) is the only accessor."
        >
          <DataTable
            columns={POLICY_COLUMNS}
            rows={TEMPLATES_TABLE.policies}
            getRowKey={(p) => p.name}
          />
        </Section>

        <Section eyebrow="Governance" title="Deploy gate">
          <p className="note">
            <code>cdk/sql/rls-gate.sql</code> blocks release if any exposed table
            in <code>public</code>, <code>storage</code>, <code>auth</code>,{" "}
            <code>realtime</code>, or <code>marketinghub</code> has row security
            disabled or zero policies. Because the app reaches Postgres with the{" "}
            <code>service_role</code> key (which bypasses RLS), the real security
            boundary is the app-layer Cognito <code>marketing</code> group gate,
            enforced server-side before any query runs.
          </p>
        </Section>
      </div>
    </>
  );
}
