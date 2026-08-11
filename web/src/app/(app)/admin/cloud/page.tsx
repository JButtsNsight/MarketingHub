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
    detail: "Branches are Postgres instances only the cloud control plane can provision.",
    status: "warn",
  },
  {
    label: "Read replicas — not available here",
    detail: "Replica provisioning is managed-platform infrastructure; this deployment is deliberately single-node.",
    status: "warn",
  },
  {
    label: "Custom domains — not available here",
    detail: "White-labels hosted supabase.co endpoints — no cloud project, no hostname to replace.",
    status: "warn",
  },
  {
    label: "PrivateLink — not available here",
    detail: "Shared from a Supabase-operated AWS account, which this deployment does not have.",
    status: "warn",
  },
  {
    label: "SOC 2 — not available here",
    detail: "Attests Supabase's hosted platform, which operates nothing here.",
    status: "warn",
  },
];

/** What already does each feature's job in this stack. */
const COVERAGE_ROWS: RefRow[] = [
  {
    label: "Branching → migrations + disposable pinned Postgres",
    detail:
      "Schema changes ship as reviewed migrations; restoring a copy from pgBackRest/pg_dumpall covers real-data testing.",
    status: "ok",
  },
  {
    label: "Read replicas → sized single node, standby-on-demand",
    detail:
      "If needed, a vanilla Postgres standby can be fed from the existing WAL archive.",
    status: "ok",
  },
  {
    label: "Custom domains → we already own the hostname",
    detail:
      "There is nothing to white-label — DNS and TLS already terminate on our own hostnames.",
    status: "ok",
  },
  {
    label: "PrivateLink → private subnets by construction",
    detail: "Private subnets already do PrivateLink's job.",
    status: "ok",
  },
  {
    label: "SOC 2 → our own AWS-side controls",
    detail:
      "Assurance comes from controls we operate: Cognito/ALB authentication, pgaudit + the console query audit.",
    status: "ok",
  },
];

/** The one deliberate skip: available self-hosted, not enabled on purpose. */
const ASSISTANT_ROWS: RefRow[] = [
  {
    label: "Upstream capability",
    detail: "Ships self-hosted at our pin with a BYO OpenAI key.",
    status: "info",
  },
  {
    label: "Skipped pending sign-off",
    detail: "No BAA covers OpenAI — a compliance decision, not a technical gap.",
    status: "warn",
  },
  {
    label: "If sign-off lands",
    detail: "One env var and a Studio restart.",
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

      <div className="stack">
        <Section eyebrow="Posture" title="Cloud-platform features, honestly N/A">
          <DataTable
            columns={FEATURE_COLUMNS}
            rows={CLOUD_FEATURES}
            getRowKey={(r) => r.feature}
          />
        </Section>

        <Section eyebrow="Capability" title="Why these cannot exist here">
          <RefList items={CAPABILITY_ROWS} />
        </Section>

        <Section eyebrow="Coverage" title="What covers it here">
          <RefList items={COVERAGE_ROWS} />
        </Section>

        <Section
          eyebrow="Deliberate skip"
          title="AI Assistant — skipped pending sign-off"
        >
          <RefList items={ASSISTANT_ROWS} />
        </Section>
      </div>
    </>
  );
}
