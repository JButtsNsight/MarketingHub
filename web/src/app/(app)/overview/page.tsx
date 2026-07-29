import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { Section } from "@/components/ui/Section";
import { LineChart } from "@/components/ui/LineChart";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { getTemplateStats } from "@/lib/console/stats";
import { PROJECT } from "@/lib/console/backend-map";

// Reads request-time identity + live Supabase counts; never prerender.
export const dynamic = "force-dynamic";

const WEEKS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"];

// Placeholder analytics — sample engagement per campaign over the last 8 weeks.
// (MarketingHub does not yet capture send/engagement events; this is a mockup.)
const CAMPAIGNS = [
  { id: "c1", name: "Spring Sale Blast", metric: "Open rate", unit: "%", color: "var(--data-1)", points: [38, 41, 44, 43, 47, 52, 56, 61] },
  { id: "c2", name: "Monthly Newsletter", metric: "Click rate", unit: "%", color: "var(--data-2)", points: [12, 13, 11, 14, 16, 15, 18, 21] },
  { id: "c3", name: "Welcome Series", metric: "Conversions", unit: "", color: "var(--data-3)", points: [5, 8, 9, 12, 14, 19, 23, 27] },
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
            hint={stats.latest ? `latest ${stats.latest.slice(0, 10)}` : "no rows yet"}
          />
          <StatCard label="Email" value={email} hint="email templates" accent="var(--data-2)" />
          <StatCard label="Text" value={text} hint="text templates" accent="var(--data-3)" />
          <StatCard
            label="Categories"
            value={stats.byCategory.length}
            hint="distinct categories"
            accent="var(--data-1)"
          />
        </div>

        <Section
          eyebrow="Analytics"
          title="Campaign performance"
          description="Sample data — engagement by campaign over the last 8 weeks. Placeholder until send/engagement events are captured."
        >
          <div className="chart-grid">
            {CAMPAIGNS.map((c) => {
              const current = c.points[c.points.length - 1];
              const delta = current - c.points[0];
              return (
                <div className="surface glint chart-card" key={c.id}>
                  <div className="chart-head">
                    <span className="eyebrow">{c.metric}</span>
                    <span className="chart-title">{c.name}</span>
                    <div className="chart-value-row">
                      <span className="chart-value">
                        {current}
                        {c.unit}
                      </span>
                      <span className="chart-delta">
                        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}
                        {c.unit} vs W1
                      </span>
                    </div>
                  </div>
                  <LineChart
                    id={c.id}
                    points={c.points}
                    color={c.color}
                    labels={WEEKS}
                    height={110}
                    ariaLabel={`${c.name} ${c.metric} over 8 weeks`}
                  />
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </>
  );
}
