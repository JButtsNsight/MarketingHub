import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { listEditorTables, type EditorTable } from "@/lib/console/tables";
import { listPolicies, type PgPolicy } from "@/lib/console/pgmeta";
import { DB_TABS } from "@/lib/console/tabs";

// Reads request-time identity + live introspection; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "RLS · MarketingHub",
};

const TABLE_COLUMNS: Column<EditorTable>[] = [
  {
    key: "table",
    header: "table",
    mono: true,
    render: (t) => `${t.schema}.${t.name}`,
  },
  {
    key: "rls",
    header: "rls",
    width: "110px",
    // RLS disabled on an exposed table is the failure state on this page.
    render: (t) =>
      t.rlsEnabled ? (
        <Badge tone="var(--ok)">enabled</Badge>
      ) : (
        <Badge tone="var(--fail)">disabled</Badge>
      ),
  },
];

const POLICY_COLUMNS: Column<PgPolicy>[] = [
  { key: "name", header: "policy", mono: true },
  {
    key: "table",
    header: "table",
    mono: true,
    width: "260px",
    render: (p) => `${p.schema}.${p.table}`,
  },
  {
    key: "action",
    header: "action",
    width: "110px",
    render: (p) => (
      <Badge tone={p.action === "RESTRICTIVE" ? "var(--warn)" : undefined}>
        {p.action.toLowerCase()}
      </Badge>
    ),
  },
  { key: "command", header: "command", mono: true, width: "90px" },
  {
    key: "roles",
    header: "roles",
    mono: true,
    width: "180px",
    render: (p) => p.roles.join(", "),
  },
  {
    key: "definition",
    header: "using / check",
    mono: true,
    render: (p) => {
      const text = [p.definition, p.check].filter(Boolean).join(" · ") || "—";
      return (
        <span title={text}>
          {text.length > 60 ? `${text.slice(0, 59)}…` : text}
        </span>
      );
    },
  },
];

/**
 * Live RLS posture — real policies and per-table RLS state from
 * postgres-meta, replacing the old static reference. The house doctrine:
 * every exposed table is deny-by-default for anon/authenticated; the app
 * path is service_role (BYPASSRLS) behind the Cognito group gate. Policy
 * changes go through migrations (or, in a pinch, the SQL editor).
 */
export default async function RlsPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let tables: EditorTable[] | null = null;
  let policies: PgPolicy[] = [];
  try {
    [tables, policies] = await Promise.all([
      listEditorTables(),
      listPolicies(["marketinghub", "public", "storage"]),
    ]);
  } catch {
    tables = null;
  }

  if (!tables) {
    return (
      <>
        <PageHeader eyebrow="Database" title="Policies" />
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

  const unprotected = tables.filter((t) => !t.rlsEnabled);

  return (
    <>
      <PageHeader
        eyebrow="Database"
        title="Policies"
      />
      <Tabs items={DB_TABS} />

      <div className="stack">
        <div className="stat-grid">
          <StatCard
            label="RLS enabled"
            value={tables.filter((t) => t.rlsEnabled).length}
            hint={`of ${tables.length} tables`}
            accent="var(--data-3)"
          />
          {/* No accent: any unprotected exposed table is an attention state. */}
          <StatCard
            label="Unprotected"
            value={unprotected.length}
            hint={
              unprotected.length > 0
                ? unprotected.map((t) => t.name).join(", ")
                : "all covered"
            }
          />
          <StatCard label="Policies" value={policies.length} accent="var(--data-2)" />
        </div>

        <Section
          eyebrow="Tables"
          title="RLS coverage"
          description="Every PostgREST-exposed table must have RLS enabled + forced with an explicit deny-all restrictive policy (enforced by the rls-gate in CI/deploy)."
        >
          <DataTable
            columns={TABLE_COLUMNS}
            rows={tables}
            getRowKey={(t) => `${t.schema}.${t.name}`}
            empty="No tables."
          />
        </Section>

        <Section
          eyebrow="Policies"
          title="Active policies"
          description="Live policy definitions. Changes belong in migrations (cdk/sql) so the rls-gate and code review see them."
        >
          <DataTable
            columns={POLICY_COLUMNS}
            rows={policies}
            getRowKey={(p) => `${p.schema}.${p.table}.${p.name}`}
            empty="No policies reported."
          />
        </Section>
      </div>
    </>
  );
}
