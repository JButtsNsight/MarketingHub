import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import { allQueueMetrics, listQueues } from "@/lib/console/queues";
import {
  QueuesClient,
  type QueueOverviewRow,
} from "@/components/console/QueuesClient";

// Reads request-time identity + live pgmq state; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Queues · MarketingHub",
};

/** Integrations section sub-nav (pgmq lives beside pg_cron). */
const INTEGRATIONS_TABS: TabItem[] = [
  { href: "/integrations/cron", label: "Cron" },
  { href: "/integrations/queues", label: "Queues" },
];

/**
 * pgmq Queues (Studio → Integrations → Queues). The server pass merges
 * pgmq.list_queues() with pgmq.metrics_all() for an instant overview; the
 * client component hydrates accurate archive-table counts and drives the
 * per-queue message views + guarded send/archive/pop/delete actions.
 */
export default async function QueuesPage() {
  // Server-side group gate: mirrors the API handlers.
  await requireMarketingUser();

  let rows: QueueOverviewRow[] | null = null;
  try {
    const [queues, metrics] = await Promise.all([
      listQueues(),
      allQueueMetrics(),
    ]);
    const byName = new Map(metrics.map((m) => [m.queueName, m]));
    rows = queues.map((q) => {
      const m = byName.get(q.name);
      return {
        name: q.name,
        isPartitioned: q.isPartitioned,
        isUnlogged: q.isUnlogged,
        createdAt: q.createdAt,
        queueLength: m?.queueLength ?? 0,
        totalMessages: m?.totalMessages ?? 0,
        newestMsgAgeSec: m?.newestMsgAgeSec ?? null,
        oldestMsgAgeSec: m?.oldestMsgAgeSec ?? null,
        scrapeTime: m?.scrapeTime ?? null,
        // Accurate archive counts are hydrated client-side (one count query
        // per queue); SSR ships null so the first paint is never blocked.
        archiveCount: null,
      };
    });
  } catch {
    rows = null;
  }

  if (!rows) {
    return (
      <>
        <PageHeader eyebrow="Integrations" title="Queues" />
        <Tabs items={INTEGRATIONS_TABS} />
        <Surface className="empty-state" glint>
          <h2>pgmq unavailable</h2>
          <p>
            The queue API did not answer through postgres-meta — refresh in a
            moment.
          </p>
        </Surface>
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Integrations" title="Queues" />
      <Tabs items={INTEGRATIONS_TABS} />
      <QueuesClient initialQueues={rows} />
    </>
  );
}
