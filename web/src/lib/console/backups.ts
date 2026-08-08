import "server-only";

import { runQuery } from "./pgmeta";

/**
 * Backups data layer — the console's parity for Studio's (cloud-only) Backups
 * screen, fed by pgBackRest instead of the platform API.
 *
 * The app server can never shell out to the host, so a host cron runs
 * `pgbackrest --stanza=supabase info --output=json` every 15 minutes and
 * upserts the VERBATIM JSON into `marketinghub.backup_status` (single row,
 * id=1, latest-only). This module reads that row via pg-meta and normalizes
 * the pgBackRest shapes for the page; it never runs pgbackrest itself.
 *
 * Honesty rules baked in:
 *   - No row / no table  → `getBackupSnapshot()` returns null and the page
 *     shows an honest "host reporter not installed" empty state.
 *   - A stored payload whose stanza reports an error (status.code != 0) is
 *     still surfaced — pgbackrest info exits 0 even for a missing stanza, so
 *     `statusCode` is the truth, never the cron's exit code.
 *   - The PITR "latest restorable" point is NOT derivable from the pgBackRest
 *     JSON (archive min/max are WAL segment NAMES, not times) — callers pair
 *     the oldest `BackupRow.stoppedAt` with `getLastArchivedAt()` from
 *     pg_stat_archiver, and a null there means "archiving unverifiable".
 */

/**
 * The host cron runs every 15 minutes; three consecutive misses means the
 * reporter (or the host) is unhealthy — the page shows a staleness warning
 * once `capturedAt` is older than this.
 */
export const STALE_AFTER_MINUTES = 45;

/** One backup set from the stanza's `backup[]` array (oldest → newest). */
export interface BackupRow {
  /** pgBackRest backup label, e.g. "20260808-020001F" / "…F_…D" / "…I". */
  label: string;
  type: "full" | "diff" | "incr";
  /** ISO timestamps derived from pgBackRest's unix-epoch `timestamp.{start,stop}`. */
  startedAt: string | null;
  stoppedAt: string | null;
  /** Database size in bytes (`info.size`); null when absent. */
  dbSizeBytes: number | null;
  /** Compressed size in the repository (`info.repository.size`); null when absent. */
  repoSizeBytes: number | null;
  /** Page-checksum error flag reported by pgBackRest. */
  error: boolean;
  /** Label of the backup this one is based on; null for a full backup. */
  prior: string | null;
  /** Labels this backup depends on to restore; null for a full backup. */
  reference: string[] | null;
}

/** Normalized summary of one pgBackRest stanza. */
export interface StanzaInfo {
  name: string;
  /** pgBackRest `status.code` — 0 = ok; anything else is an error state. */
  statusCode: number;
  statusMessage: string;
  /** True while a backup is running (`status.lock.backup.held`). */
  backupLockHeld: boolean;
  backups: BackupRow[];
  /** Oldest / newest archived WAL segment NAMES (not timestamps); null when none. */
  archiveMin: string | null;
  archiveMax: string | null;
}

export interface BackupSnapshot {
  /** When the host cron captured this payload (timestamptz as text). */
  capturedAt: string;
  /** Normalized stanza, or null when the payload held no parseable stanza. */
  stanza: StanzaInfo | null;
  /** The verbatim (parsed) pgbackrest info JSON, for the raw view. */
  raw: unknown;
}

/** The stanza name our host is configured with (cdk/assets/pgbackrest.conf). */
const STANZA_NAME = "supabase";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unix epoch seconds → ISO string; null for anything non-numeric. A FINITE
 * epoch can still overflow the ECMAScript Date range (|ms| > 8.64e15, i.e.
 * |seconds| > 8.64e12) — `toISOString()` would throw RangeError and a crafted
 * payload could 500 the refresh route, so an out-of-range timestamp degrades
 * to null ("—") like every other defensively-parsed field.
 */
function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBackupRow(value: unknown): BackupRow | null {
  if (!isRecord(value)) return null;
  const label = typeof value.label === "string" ? value.label : null;
  const type = value.type;
  if (label === null) return null;
  if (type !== "full" && type !== "diff" && type !== "incr") return null;

  const timestamp = isRecord(value.timestamp) ? value.timestamp : {};
  const info = isRecord(value.info) ? value.info : {};
  const repository = isRecord(info.repository) ? info.repository : {};
  const reference = Array.isArray(value.reference)
    ? value.reference.filter((r): r is string => typeof r === "string")
    : null;

  return {
    label,
    type,
    startedAt: epochToIso(timestamp.start),
    stoppedAt: epochToIso(timestamp.stop),
    dbSizeBytes: toNullableNumber(info.size),
    repoSizeBytes: toNullableNumber(repository.size),
    error: value.error === true,
    prior: typeof value.prior === "string" ? value.prior : null,
    reference,
  };
}

/**
 * Normalize one stanza object from the pgbackrest info array. The archive
 * min/max come from the LAST archive entry with data — with multiple entries
 * (post-upgrade stanzas) the newest db id sorts last.
 */
function toStanzaInfo(value: unknown): StanzaInfo | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;

  const status = isRecord(value.status) ? value.status : {};
  const lock = isRecord(status.lock) ? status.lock : {};
  const backupLock = isRecord(lock.backup) ? lock.backup : {};

  const backups = Array.isArray(value.backup)
    ? value.backup
        .map(toBackupRow)
        .filter((b): b is BackupRow => b !== null)
    : [];

  let archiveMin: string | null = null;
  let archiveMax: string | null = null;
  if (Array.isArray(value.archive)) {
    for (const entry of value.archive) {
      if (!isRecord(entry)) continue;
      if (typeof entry.min === "string") archiveMin = entry.min;
      if (typeof entry.max === "string") archiveMax = entry.max;
    }
  }

  return {
    name: value.name,
    statusCode:
      typeof status.code === "number" && Number.isFinite(status.code)
        ? status.code
        : -1,
    statusMessage: typeof status.message === "string" ? status.message : "",
    backupLockHeld: backupLock.held === true,
    backups,
    archiveMin,
    archiveMax,
  };
}

/**
 * Pick our stanza out of the top-level pgbackrest info ARRAY. Prefer the one
 * named "supabase"; fall back to the first parseable entry so a renamed
 * stanza still renders (with its real name) rather than vanishing.
 */
function pickStanza(payload: unknown): StanzaInfo | null {
  if (!Array.isArray(payload)) return null;
  const stanzas = payload
    .map(toStanzaInfo)
    .filter((s): s is StanzaInfo => s !== null);
  return stanzas.find((s) => s.name === STANZA_NAME) ?? stanzas[0] ?? null;
}

/** True when a pg error means `marketinghub.backup_status` does not exist. */
function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /backup_status.*does not exist|42P01/i.test(message);
}

/**
 * Latest host-reported pgBackRest snapshot, or null when the status table is
 * missing (migration not applied) or empty (host reporter not installed yet)
 * — both are honest empty states, not errors.
 */
export async function getBackupSnapshot(): Promise<BackupSnapshot | null> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await runQuery(
      `select payload,
              captured_at::text as captured_at
         from marketinghub.backup_status
        where id = 1`,
    );
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
  const row = rows[0];
  if (!row) return null;

  // pg-meta returns jsonb as parsed JSON; tolerate a stringified payload too.
  let payload: unknown = row.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }

  return {
    capturedAt: String(row.captured_at ?? ""),
    stanza: pickStanza(payload),
    raw: payload,
  };
}

/**
 * `pg_stat_archiver.last_archived_time` — the live "latest restorable" end of
 * the PITR window (the pgBackRest JSON only carries WAL segment names). Null
 * means Postgres has not recorded a successful archive: the page must warn
 * "archiving unverifiable" rather than claim a PITR window.
 */
export async function getLastArchivedAt(): Promise<string | null> {
  const rows = await runQuery(
    `select last_archived_time::text as last_archived_time
       from pg_stat_archiver`,
  );
  const value = rows[0]?.last_archived_time;
  return typeof value === "string" && value.length > 0 ? value : null;
}
