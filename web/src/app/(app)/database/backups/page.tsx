import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Surface } from "@/components/Surface";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  getBackupSnapshot,
  getLastArchivedAt,
  STALE_AFTER_MINUTES,
  type BackupSnapshot,
} from "@/lib/console/backups";
import { DB_TABS } from "@/lib/console/tabs";
import { BackupsClient } from "@/components/console/BackupsClient";

// Reads request-time identity + the live status row; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Backups · MarketingHub",
};

/**
 * Backups — the console's parity for Studio's Backups screen, which is
 * platform-API-backed and therefore dead self-hosted. Here the source of truth
 * is pgBackRest on the database host: a 15-minute host cron stores the
 * verbatim `pgbackrest info` JSON in `marketinghub.backup_status`, and this
 * page renders that snapshot plus a live pg_stat_archiver PITR cross-check.
 *
 * READ-ONLY by design: backups run from the host cron and restores run from
 * the restore-drill runbook — nothing on this surface can trigger either.
 */
export default async function BackupsPage() {
  // Server-side group gate: mirrors the API handler.
  await requireMarketingUser();

  let snapshot: BackupSnapshot | null = null;
  try {
    snapshot = await getBackupSnapshot();
  } catch {
    // pg-meta unreachable — same honest empty state as "no row yet".
    snapshot = null;
  }

  if (!snapshot) {
    return (
      <>
        <PageHeader title="Backups" />
        <Tabs items={DB_TABS} />
        <Surface className="empty-state" glint>
          <h2>Backup status unreachable</h2>
          <p>
            No pgBackRest snapshot to read — the host reporter cron is not
            installed yet (or the status table has not been migrated). Install
            it per §12 of docs/runbooks/marketinghub-app-deploy.md. Backups may
            still be running on the host; this page just cannot see them until
            the reporter lands.
          </p>
        </Surface>
      </>
    );
  }

  // Best-effort PITR cross-check: a failed archiver read must not hide the
  // backup list — null renders as "archiving unverifiable".
  let lastArchivedAt: string | null = null;
  try {
    lastArchivedAt = await getLastArchivedAt();
  } catch {
    lastArchivedAt = null;
  }

  return (
    <>
      <PageHeader title="Backups" />
      <Tabs items={DB_TABS} />
      <BackupsClient
        initialSnapshot={snapshot}
        initialLastArchivedAt={lastArchivedAt}
        staleAfterMinutes={STALE_AFTER_MINUTES}
      />
    </>
  );
}
