"use client";

import { useState } from "react";

import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { KeyValue } from "../ui/KeyValue";
import { RefList } from "../ui/RefList";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { StatusPill } from "../ui/StatusPill";
import { Surface } from "../Surface";
import type { BackupRow, BackupSnapshot } from "@/lib/console/backups";

/**
 * The interactive shell for the Backups screen — Studio's Backups page is
 * platform-API-backed (dead self-hosted), so this renders the pgBackRest truth
 * instead: the host reporter cron's latest `pgbackrest info` JSON from
 * `marketinghub.backup_status`, plus a live pg_stat_archiver cross-check.
 *
 * READ-ONLY: there is deliberately NO trigger for backups or restores —
 * those are host operations (cron / restore-drill runbook), and a console
 * button would be aspirational UI. The only action here is Refresh, which
 * re-reads status through the group-gated /api/console/backups route.
 */

/** What the /api/console/backups route returns. */
interface StatusResponse {
  snapshot: BackupSnapshot | null;
  lastArchivedAt: string | null;
}

/** Fixed UTC format — locale-independent, timestamp-honest. */
function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function fmtDuration(startedAt: string | null, stoppedAt: string | null): string {
  if (!startedAt || !stoppedAt) return "—";
  const ms = Date.parse(stoppedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Whole minutes since `ts`; null when the timestamp is unparseable. */
function minutesSince(ts: string): number | null {
  const at = new Date(ts).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((Date.now() - at) / 60_000));
}

/** Backup type → data-pool tone (never --fail; red is reserved for failure). */
const TYPE_TONE: Record<BackupRow["type"], string> = {
  full: "var(--data-2)",
  diff: "var(--data-3)",
  incr: "var(--data-4)",
};

const BACKUP_COLUMNS: Column<BackupRow>[] = [
  { key: "label", header: "label", mono: true, width: "300px" },
  {
    key: "type",
    header: "type",
    width: "90px",
    render: (b) => <Badge tone={TYPE_TONE[b.type]}>{b.type}</Badge>,
  },
  {
    key: "stoppedAt",
    header: "finished",
    mono: true,
    width: "170px",
    render: (b) => fmtTs(b.stoppedAt),
  },
  {
    key: "duration",
    header: "duration",
    mono: true,
    align: "right",
    width: "100px",
    render: (b) => fmtDuration(b.startedAt, b.stoppedAt),
  },
  {
    key: "dbSizeBytes",
    header: "db size",
    mono: true,
    align: "right",
    width: "110px",
    render: (b) => formatBytes(b.dbSizeBytes),
  },
  {
    key: "repoSizeBytes",
    header: "repo size",
    mono: true,
    align: "right",
    width: "110px",
    render: (b) => formatBytes(b.repoSizeBytes),
  },
  {
    key: "error",
    header: "checksum",
    width: "130px",
    render: (b) =>
      b.error ? (
        // A page-checksum error IS a failure state — red is correct here.
        <StatusPill status="fail">error</StatusPill>
      ) : (
        <StatusPill status="ok">clean</StatusPill>
      ),
  },
];

export function BackupsClient({
  initialSnapshot,
  initialLastArchivedAt,
  staleAfterMinutes,
}: {
  initialSnapshot: BackupSnapshot;
  initialLastArchivedAt: string | null;
  /** STALE_AFTER_MINUTES, passed by the server page (the lib is server-only). */
  staleAfterMinutes: number;
}) {
  const [snapshot, setSnapshot] = useState<BackupSnapshot | null>(initialSnapshot);
  const [lastArchivedAt, setLastArchivedAt] = useState(initialLastArchivedAt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/console/backups");
      const body = (await res.json().catch(() => null)) as
        | (StatusResponse & { error?: string })
        | null;
      if (!res.ok || !body) {
        setError(body?.error ?? "Refreshing backup status failed.");
        return;
      }
      setSnapshot(body.snapshot);
      setLastArchivedAt(body.lastArchivedAt ?? null);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  };

  const toolbar = (
    <div className="dgrid-toolbar">
      {snapshot ? (
        <>
          <span className="mono">reported {fmtTs(snapshot.capturedAt)}</span>
          {(() => {
            const age = minutesSince(snapshot.capturedAt);
            if (age === null || age <= staleAfterMinutes) return null;
            return (
              <StatusPill status="warn">
                stale — reported {age} min ago (reporter runs every 15 min)
              </StatusPill>
            );
          })()}
        </>
      ) : null}
      <span className="spacer" />
      <button
        type="button"
        className="type-chip"
        disabled={loading}
        onClick={() => void refresh()}
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );

  // The status row disappeared on refresh (table dropped / row deleted):
  // same honest empty state the server page renders on first load.
  if (!snapshot) {
    return (
      <div className="stack">
        {toolbar}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Surface className="empty-state" glint>
          <h2>Backup status unreachable</h2>
          <p>
            No pgBackRest snapshot to read — the host reporter cron is not
            installed.
          </p>
        </Surface>
      </div>
    );
  }

  const stanza = snapshot.stanza;

  // A stored row whose payload held no parseable stanza array — surfaced
  // honestly rather than pretending the reporter never ran.
  if (!stanza) {
    return (
      <div className="stack">
        {toolbar}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Surface className="empty-state" glint>
          <h2>Status payload unreadable</h2>
          <p>The host reporter stored a payload with no parseable stanza.</p>
        </Surface>
      </div>
    );
  }

  const counts = { full: 0, diff: 0, incr: 0 };
  for (const b of stanza.backups) counts[b.type] += 1;

  // pgBackRest lists backups oldest → newest; display newest first.
  const latest = stanza.backups[stanza.backups.length - 1] ?? null;
  const newestFirst = [...stanza.backups].reverse();

  // PITR window: earliest = oldest retained set's stop time; latest = the
  // newest WAL segment Postgres reported archived (pg_stat_archiver).
  const earliestRestorable = stanza.backups[0]?.stoppedAt ?? null;

  return (
    <div className="stack">
      {toolbar}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="pgBackRest"
        title={`Stanza ${stanza.name}`}
        description="Host-reported pgbackrest info, captured every 15 minutes."
        actions={
          <>
            {stanza.backupLockHeld ? (
              <Badge title="pgBackRest reports the backup lock held — a backup is running right now.">
                backup in progress
              </Badge>
            ) : null}
            {stanza.statusCode === 0 ? (
              <StatusPill status="ok">stanza ok</StatusPill>
            ) : (
              <StatusPill status="fail">
                {stanza.statusMessage || "error"} (code {stanza.statusCode})
              </StatusPill>
            )}
          </>
        }
      >
        <div className="stat-grid">
          <StatCard
            label="Backups retained"
            value={stanza.backups.length}
            hint={`${counts.full} full · ${counts.diff} diff · ${counts.incr} incr`}
          />
          <StatCard
            label="Database size"
            value={formatBytes(latest?.dbSizeBytes ?? null)}
            hint="latest set"
            accent="var(--data-2)"
          />
          <StatCard
            label="Repository size"
            value={formatBytes(latest?.repoSizeBytes ?? null)}
            hint="latest set, compressed"
            accent="var(--data-3)"
          />
        </div>
      </Section>

      <Section
        eyebrow="Backups"
        title="Backup sets"
        description="Physical pgBackRest sets, newest first."
        actions={<Badge>physical</Badge>}
      >
        <div className="stack">
          <KeyValue
            items={[
              {
                label: "Schedule",
                value:
                  "full Sun 02:00 · diff Mon–Sat 02:00 · logical dump 03:00 (host cron)",
                mono: true,
              },
              { label: "Retention", value: "4 full · 14 diff", mono: true },
            ]}
          />
          <DataTable
            columns={BACKUP_COLUMNS}
            rows={newestFirst}
            getRowKey={(b) => b.label}
            empty="No completed backups reported yet — the first full backup runs Sunday 02:00."
          />
        </div>
      </Section>

      <Section
        eyebrow="Point-in-time recovery"
        title="Restore window"
        description="Earliest = oldest retained set's finish; latest = newest archived WAL segment."
      >
        <KeyValue
          items={[
            {
              label: "Earliest restorable",
              value: fmtTs(earliestRestorable),
              mono: true,
            },
            {
              label: "Latest restorable",
              value: lastArchivedAt ? (
                fmtTs(lastArchivedAt)
              ) : (
                <StatusPill status="warn">
                  archiving unverifiable — no archived WAL recorded
                </StatusPill>
              ),
              mono: lastArchivedAt != null,
            },
            {
              label: "WAL archive range",
              value:
                stanza.archiveMin && stanza.archiveMax
                  ? `${stanza.archiveMin} → ${stanza.archiveMax}`
                  : "—",
              mono: true,
            },
          ]}
        />
      </Section>

      <Section eyebrow="Restore drill" title="Restore drill">
        <RefList
          items={[
            {
              label: "Runbook",
              detail:
                "docs/runbooks/restore-drill.md — the quarterly point-in-time restore drill.",
              status: "info",
            },
            {
              label: "Objectives",
              detail: "RPO ≤ 5 minutes (WAL archiving) · RTO < 2 hours.",
              status: "info",
            },
            {
              label: "Primary path",
              detail:
                "pgbackrest --type=time point-in-time restore, then rls-gate.sh must pass before the restored database serves traffic.",
              status: "info",
            },
            {
              label: "Last drill",
              detail:
                "Not tracked here — drill history is not derivable from pgbackrest info, so this page makes no claim about it.",
              status: "info",
            },
          ]}
        />
      </Section>
    </div>
  );
}

export default BackupsClient;
