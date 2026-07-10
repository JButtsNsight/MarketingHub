import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { RefList } from "@/components/ui/RefList";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getTemplateStats } from "@/lib/console/stats";
import {
  PROJECT,
  SERVICES,
  SECURITY_POSTURE,
  REFERENCE_DISCLAIMER,
  type ServiceInfo,
} from "@/lib/console/backend-map";

// Reads request-time identity + live Supabase counts; never prerender.
export const dynamic = "force-dynamic";

const SERVICE_COLUMNS: Column<ServiceInfo>[] = [
  { key: "name", header: "Service", mono: true, width: "26%" },
  { key: "role", header: "Role" },
  { key: "exposure", header: "Exposure", width: "22%" },
];

const EXPLORE = [
  { href: "/database", title: "Database", desc: "Browse rows, schema, and RLS for marketinghub.templates." },
  { href: "/storage", title: "Storage", desc: "The private campaign-templates bucket and its objects." },
  { href: "/auth", title: "Authentication", desc: "The Cognito + Google SAML identity model and your session." },
  { href: "/api-reference", title: "API", desc: "PostgREST, GraphQL, and Storage endpoints exposed by Kong." },
  { href: "/infrastructure", title: "Infrastructure", desc: "Services, security posture, backups, and observability." },
];

export default async function OverviewPage() {
  await requireMarketingUser();
  const stats = await getTemplateStats();

  const email = stats.byType.find((t) => t.label === "email")?.count ?? 0;
  const text = stats.byType.find((t) => t.label === "text")?.count ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title="Overview"
        subtitle={`${PROJECT.name} · ${PROJECT.bundle} · ${PROJECT.postgres}`}
      />

      <div className="stack">
        <div className="stat-grid">
          <StatCard
            label="Templates"
            value={stats.total}
            hint={
              stats.latest
                ? `latest ${stats.latest.slice(0, 10)}`
                : "no rows yet"
            }
          />
          <StatCard
            label="Email"
            value={email}
            hint="email templates"
            accent="var(--data-2)"
          />
          <StatCard
            label="Text"
            value={text}
            hint="text templates"
            accent="var(--data-3)"
          />
          <StatCard
            label="Categories"
            value={stats.byCategory.length}
            hint="distinct categories"
            accent="var(--data-1)"
          />
        </div>

        <div className="split-2">
          <Section
            eyebrow="Backend"
            title="Services"
            description="The Supabase containers this stack provisions on the host."
          >
            <DataTable
              columns={SERVICE_COLUMNS}
              rows={SERVICES}
              getRowKey={(s) => s.name}
            />
            <p className="ref-note">
              <Badge>reference</Badge>
              <span>{REFERENCE_DISCLAIMER}</span>
            </p>
          </Section>

          <Section
            eyebrow="Security"
            title="Posture"
            description="HIPAA-oriented controls defined in the infrastructure."
          >
            <RefList items={SECURITY_POSTURE} />
          </Section>
        </div>

        <Section eyebrow="Explore" title="Jump to a section">
          <div className="card-grid">
            {EXPLORE.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className="surface glint link-card"
              >
                <span className="link-card-title">{c.title}</span>
                <span className="link-card-desc">{c.desc}</span>
              </Link>
            ))}
          </div>
        </Section>
      </div>
    </>
  );
}
