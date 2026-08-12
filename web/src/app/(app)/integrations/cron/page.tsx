import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { Forbidden } from "@/components/ui/Forbidden";
import { requireSectionUser } from "@/lib/requireSection";
import {
  listCronJobs,
  listCronRuns,
  type CronJob,
  type CronRun,
} from "@/lib/console/cron";
import { CronClient } from "@/components/console/CronClient";

// Reads request-time identity + live pg_cron catalog; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cron · MarketingHub",
};

// The Integrations section (pg_cron / pgmq / supabase_vault surfaced as their
// own screens), matching the Nav group. Local to this surface — the shared
// tabs module owns only the Database section.
const INTEGRATION_TABS: TabItem[] = [
  { href: "/integrations/cron", label: "Cron" },
  { href: "/integrations/queues", label: "Queues" },
  { href: "/integrations/vault", label: "Vault" },
];

/**
 * The Cron integration screen (Studio → Integrations → Cron): the pg_cron job
 * catalog and recent run history, with schedule/unschedule as guarded writes.
 * Auth is enforced server-side here (mirrors the API handlers); the interactive
 * bits live in the client component.
 */
export default async function CronPage() {
  // Server-side section gate: mirrors the API handlers.
  const gate = await requireSectionUser("platform");
  if (!gate.ok) return <Forbidden message="Platform access required." />;

  let jobs: CronJob[] | null = null;
  let runs: CronRun[] = [];
  try {
    [jobs, runs] = await Promise.all([listCronJobs(), listCronRuns()]);
  } catch {
    jobs = null;
  }

  if (!jobs) {
    return (
      <>
        <PageHeader eyebrow="Integrations" title="Cron" />
        <Tabs items={INTEGRATION_TABS} />
        <Surface className="empty-state" glint>
          <h2>pg_cron unavailable</h2>
          <p>
            The cron catalog did not answer through the data API — refresh in a
            moment.
          </p>
        </Surface>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="Cron"
        count={`${jobs.length} job${jobs.length === 1 ? "" : "s"}`}
      />
      <Tabs items={INTEGRATION_TABS} />
      <CronClient initialJobs={jobs} initialRuns={runs} />
    </>
  );
}
