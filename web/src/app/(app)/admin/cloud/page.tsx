import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList, type RefRow } from "@/components/ui/RefList";
import { requireMarketingUser } from "@/lib/requireMarketingUser";

// Static reference content, but the page still reads request-time identity
// for the group gate; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cloud Features · MarketingHub",
};

/**
 * Cloud Features (Studio's cloud-platform surface, honestly N/A here) — a
 * static capability panel in the /logs/drains mold, deliberately fetch-free.
 *
 * Branching, Read replicas, Custom domains, PrivateLink and SOC 2 are all
 * implemented by the Supabase CLOUD control plane — none of them ship in the
 * open-source docker bundle at our pin (supabase/supabase@v1.26.05), and this
 * deployment has no Supabase cloud account anywhere, so they cannot exist
 * here in any state. This page exists so nobody goes hunting for a toggle:
 * each feature gets an explicit N/A plus what covers the underlying need in
 * this stack instead.
 *
 * The AI Assistant is the one non-cloud-only entry: Studio at our pin ships
 * it self-hosted (BYO OPENAI_API_KEY). It is SKIPPED PENDING SIGN-OFF — a
 * compliance decision (schema metadata would leave the VPC for OpenAI with
 * no BAA), not a technical gap.
 */

/** One cloud-platform feature and its honest status in this deployment. */
interface CloudFeature {
  feature: string;
  maturity: string;
  selfHosted: string;
  here: string;
}

const CLOUD_FEATURES: CloudFeature[] = [
  {
    feature: "Branching",
    maturity: "Beta",
    selfHosted: "cloud-only",
    here: "N/A — control plane",
  },
  {
    feature: "Read replicas",
    maturity: "GA",
    selfHosted: "cloud-only",
    here: "N/A — control plane",
  },
  {
    feature: "Custom domains",
    maturity: "GA",
    selfHosted: "cloud-only",
    here: "N/A — control plane",
  },
  {
    feature: "PrivateLink",
    maturity: "Beta",
    selfHosted: "cloud-only",
    here: "N/A — control plane",
  },
  {
    feature: "SOC 2",
    maturity: "GA",
    selfHosted: "cloud-only",
    here: "N/A — control plane",
  },
  {
    feature: "AI Assistant",
    maturity: "Public Alpha",
    selfHosted: "partial (BYO OpenAI key)",
    here: "skipped pending sign-off",
  },
];

const FEATURE_COLUMNS: Column<CloudFeature>[] = [
  { key: "feature", header: "feature", width: "22%" },
  {
    key: "maturity",
    header: "maturity",
    width: "18%",
    render: (r) => <Badge>{r.maturity}</Badge>,
  },
  { key: "selfHosted", header: "self-hosted", mono: true, width: "26%" },
  { key: "here", header: "status here", render: (r) => <span className="mono">{r.here}</span> },
];

/** Why each cloud-only feature cannot exist in this deployment. */
const CAPABILITY_ROWS: RefRow[] = [
  {
    label: "Branching — not available here",
    detail:
      "Branches are separate managed Postgres instances the Supabase cloud control plane provisions, pauses and merges. The docker bundle ships none of that orchestration, and with no cloud account there is nothing to create a branch on.",
    status: "warn",
  },
  {
    label: "Read replicas — not available here",
    detail:
      "Replica provisioning, WAL-G-based sync and the geo-routed API load balancer are managed-platform infrastructure with no self-hosted counterpart. This deployment is deliberately single-node (one EC2 instance + auto-recovery).",
    status: "warn",
  },
  {
    label: "Custom domains — not available here",
    detail:
      "The feature white-labels a hosted project's <ref>.supabase.co endpoints via the platform edge. With no cloud project there is no supabase.co hostname to replace — the premise does not apply.",
    status: "warn",
  },
  {
    label: "PrivateLink — not available here",
    detail:
      "PrivateLink is the cloud control plane sharing VPC Lattice resource configurations from Supabase's AWS account into yours via RAM. There is no Supabase-operated AWS account in this deployment to share from.",
    status: "warn",
  },
  {
    label: "SOC 2 — not available here",
    detail:
      "SOC 2 is an audit attestation of Supabase-the-company's hosted platform and corporate controls. It cannot transfer to infrastructure Supabase does not operate, which is all of this deployment.",
    status: "warn",
  },
];

/** What already does each feature's job in this stack. */
const COVERAGE_ROWS: RefRow[] = [
  {
    label: "Branching → migrations + disposable pinned Postgres",
    detail:
      "Schema changes land as reviewed, idempotent cdk/sql migrations, and a throwaway pinned container (docker run supabase/postgres:15.8.1.085 — the same mechanism scripts/gen-db-types.sh uses) gives an isolated place to test them; restoring a copy from pgBackRest/pg_dumpall covers testing against real data. Wave 8 adds the declarative supabase/schemas workflow for new schemas.",
    status: "ok",
  },
  {
    label: "Read replicas → sized single node, standby-on-demand",
    detail:
      "An internal team's read load fits the single instance with headroom, and EC2 auto-recovery covers hardware failure. If read isolation ever matters, a vanilla Postgres standby can be fed from the existing WAL archive — plain Postgres work, no cloud feature required.",
    status: "ok",
  },
  {
    label: "Custom domains → we already own the hostname",
    detail:
      "DNS and ACM TLS terminate at the Cognito-authenticated ALB in front of Kong/Studio, so every hostname in play is already ours. There is nothing to white-label.",
    status: "ok",
  },
  {
    label: "PrivateLink → private subnets by construction",
    detail:
      "The entire stack runs in private subnets; database traffic never crosses the public internet, and operator access rides the SSM tunnel. Private subnets already do PrivateLink's job.",
    status: "ok",
  },
  {
    label: "SOC 2 → our own AWS-side controls",
    detail:
      "Assurance here derives from controls we operate: Cognito/ALB authentication, pgaudit + the console query audit, KMS-encrypted S3, Object-Lock backups, and CloudWatch alarms. A hosted-platform attestation would not cover this environment anyway.",
    status: "ok",
  },
];

/** The one deliberate skip: available self-hosted, not enabled on purpose. */
const ASSISTANT_ROWS: RefRow[] = [
  {
    label: "Upstream capability",
    detail:
      "Studio at our pin ships the AI Assistant self-hosted: adding an OPENAI_API_KEY to the Studio environment (rendered by cdk/assets/render-env.sh) enables SQL/policy drafting help that sends schema metadata to the OpenAI API.",
    status: "info",
  },
  {
    label: "Skipped pending sign-off",
    detail:
      "Deliberately not enabled: schema metadata would leave the VPC for OpenAI with no BAA in place — a compliance decision, not a technical gap. No key is configured, so there is nothing to render or toggle here.",
    status: "warn",
  },
  {
    label: "If sign-off lands",
    detail:
      "Enablement is one env var in cdk/assets/render-env.sh plus a Studio restart. The prerequisite is a compliance/legal review of exactly what the assistant transmits (schema-only vs row data) and the provider terms — until that sign-off exists, this row stays off.",
    status: "info",
  },
];

export default async function CloudFeaturesPage() {
  // Server-side group gate: static reference content, but the console stays
  // behind the marketing group like every other surface.
  await requireMarketingUser();

  return (
    <>
      <PageHeader title="Cloud Features" />

      <p className="ref-note" style={{ marginBottom: "18px" }}>
        <Badge>reference</Badge>
        <span>
          Static capability panel — nothing on this page queries anything. The
          features below require the Supabase cloud control plane, which this
          cloud-account-free deployment does not have (plus one deliberately
          skipped assistant); each section states what covers the need in this
          stack instead.
        </span>
      </p>

      <div className="stack">
        <Section
          eyebrow="Posture"
          title="Cloud-platform features, honestly N/A"
          description="The status ledger — no toggles exist for these anywhere in this deployment."
        >
          <DataTable
            columns={FEATURE_COLUMNS}
            rows={CLOUD_FEATURES}
            getRowKey={(r) => r.feature}
          />
        </Section>

        <Section
          eyebrow="Capability"
          title="Why these cannot exist here"
          description="Each one is implemented by the Supabase cloud control plane, not by any component in the open-source bundle at our pin (supabase/supabase@v1.26.05)."
        >
          <RefList items={CAPABILITY_ROWS} />
        </Section>

        <Section
          eyebrow="Coverage"
          title="What covers it here"
          description="The underlying needs are met by things this stack already runs."
        >
          <RefList items={COVERAGE_ROWS} />
        </Section>

        <Section
          eyebrow="Deliberate skip"
          title="AI Assistant — skipped pending sign-off"
          description="The one entry that IS available self-hosted; it stays off by decision, not by limitation."
        >
          <RefList items={ASSISTANT_ROWS} />
        </Section>
      </div>
    </>
  );
}
