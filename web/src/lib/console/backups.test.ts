// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn() }));

vi.mock("./pgmeta", () => ({ runQuery: h.runQuery }));

import {
  getBackupSnapshot,
  getLastArchivedAt,
  STALE_AFTER_MINUTES,
} from "./backups";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  h.runQuery.mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures — shaped from EMPIRICAL pgbackrest 2.45 `info --output=json` output
// (top level is an ARRAY of stanza objects; backup[] is oldest → newest).
// ---------------------------------------------------------------------------

const FULL_BACKUP = {
  archive: { start: "000000010000000000000004", stop: "000000010000000000000004" },
  backrest: { format: 5, version: "2.45" },
  database: { id: 1, "repo-key": 1 },
  error: false,
  info: {
    delta: 25774963,
    repository: { delta: 3123651, size: 3123651 },
    size: 25774963,
  },
  label: "20260802-020001F",
  lsn: { start: "0/4000028", stop: "0/4000138" },
  prior: null,
  reference: null,
  timestamp: { start: 1785636001, stop: 1785636010 },
  type: "full",
};

const DIFF_BACKUP = {
  archive: { start: "000000010000000000000006", stop: "000000010000000000000006" },
  backrest: { format: 5, version: "2.45" },
  database: { id: 1, "repo-key": 1 },
  error: true,
  info: {
    delta: 1048576,
    repository: { delta: 8192, size: 3131843 },
    size: 25774963,
  },
  label: "20260803-020001F_20260803-020101D",
  lsn: { start: "0/6000028", stop: "0/6000138" },
  prior: "20260802-020001F",
  reference: ["20260802-020001F"],
  timestamp: { start: 1785722401, stop: 1785722405 },
  type: "diff",
};

const INCR_BACKUP = {
  ...DIFF_BACKUP,
  error: false,
  label: "20260803-020001F_20260804-020101I",
  prior: "20260803-020001F_20260803-020101D",
  reference: ["20260802-020001F", "20260803-020001F_20260803-020101D"],
  timestamp: { start: 1785808801, stop: 1785808803 },
  type: "incr",
};

const HEALTHY_STANZA = {
  archive: [
    {
      database: { id: 1, "repo-key": 1 },
      id: "15-1",
      max: "0000000100000000000000A2",
      min: "000000010000000000000003",
    },
  ],
  backup: [FULL_BACKUP, DIFF_BACKUP, INCR_BACKUP],
  cipher: "none",
  db: [{ id: 1, "repo-key": 1, "system-id": 7300000000000000000, version: "15" }],
  name: "supabase",
  repo: [{ cipher: "none", key: 1, status: { code: 0, message: "ok" } }],
  status: {
    code: 0,
    lock: { backup: { held: false } },
    message: "ok",
  },
};

/** `info` on a configured-but-never-backed-up stanza: code 1, empty arrays. */
const MISSING_STANZA = {
  archive: [],
  backup: [],
  cipher: "none",
  db: [],
  name: "supabase",
  repo: [{ cipher: "none", key: 1, status: { code: 1, message: "missing stanza path" } }],
  status: {
    code: 1,
    lock: { backup: { held: false } },
    message: "missing stanza path",
  },
};

function statusRow(payload: unknown, capturedAt = "2026-08-08 12:00:00+00") {
  return [{ payload, captured_at: capturedAt }];
}

describe("getBackupSnapshot", () => {
  test("reads the single latest-only row by id", async () => {
    h.runQuery.mockResolvedValue(statusRow([HEALTHY_STANZA]));
    await getBackupSnapshot();
    const sql = lastSql();
    expect(sql).toContain("from marketinghub.backup_status");
    expect(sql).toContain("where id = 1");
  });

  test("normalizes a healthy stanza: status, lock, archive window", async () => {
    h.runQuery.mockResolvedValue(statusRow([HEALTHY_STANZA]));
    const snap = await getBackupSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.capturedAt).toBe("2026-08-08 12:00:00+00");
    expect(snap!.raw).toEqual([HEALTHY_STANZA]);
    expect(snap!.stanza).toMatchObject({
      name: "supabase",
      statusCode: 0,
      statusMessage: "ok",
      backupLockHeld: false,
      archiveMin: "000000010000000000000003",
      archiveMax: "0000000100000000000000A2",
    });
  });

  test("maps backup rows: types, epoch→ISO, sizes, prior/reference", async () => {
    h.runQuery.mockResolvedValue(statusRow([HEALTHY_STANZA]));
    const snap = await getBackupSnapshot();
    const backups = snap!.stanza!.backups;
    expect(backups.map((b) => b.type)).toEqual(["full", "diff", "incr"]);

    const full = backups[0];
    expect(full).toEqual({
      label: "20260802-020001F",
      type: "full",
      startedAt: new Date(1785636001 * 1000).toISOString(),
      stoppedAt: new Date(1785636010 * 1000).toISOString(),
      dbSizeBytes: 25774963,
      repoSizeBytes: 3123651,
      error: false,
      prior: null,
      reference: null,
    });

    const diff = backups[1];
    expect(diff.error).toBe(true);
    expect(diff.prior).toBe("20260802-020001F");
    expect(diff.reference).toEqual(["20260802-020001F"]);
    expect(diff.repoSizeBytes).toBe(3131843);

    const incr = backups[2];
    expect(incr.reference).toEqual([
      "20260802-020001F",
      "20260803-020001F_20260803-020101D",
    ]);
  });

  test("multi-repo / multi-archive: last archive entry wins, status intact", async () => {
    const multi = {
      ...HEALTHY_STANZA,
      archive: [
        { database: { id: 1 }, id: "14-1", min: "0000000100000000000000AA", max: "0000000100000000000000FF" },
        { database: { id: 2 }, id: "15-2", min: "000000020000000000000001", max: "000000020000000000000042" },
      ],
      repo: [
        { cipher: "none", key: 1, status: { code: 0, message: "ok" } },
        { cipher: "aes-256-cbc", key: 2, status: { code: 0, message: "ok" } },
      ],
    };
    h.runQuery.mockResolvedValue(statusRow([multi]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza).toMatchObject({
      statusCode: 0,
      archiveMin: "000000020000000000000001",
      archiveMax: "000000020000000000000042",
    });
    expect(snap!.stanza!.backups).toHaveLength(3);
  });

  test("empty/error stanza is surfaced honestly (statusCode 1, no backups)", async () => {
    h.runQuery.mockResolvedValue(statusRow([MISSING_STANZA]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza).toMatchObject({
      name: "supabase",
      statusCode: 1,
      statusMessage: "missing stanza path",
      backups: [],
      archiveMin: null,
      archiveMax: null,
    });
  });

  test("reports a held backup lock (backup in progress)", async () => {
    const locked = {
      ...HEALTHY_STANZA,
      status: { code: 0, lock: { backup: { held: true } }, message: "ok" },
    };
    h.runQuery.mockResolvedValue(statusRow([locked]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza!.backupLockHeld).toBe(true);
  });

  test("prefers the 'supabase' stanza when several exist", async () => {
    const other = { ...HEALTHY_STANZA, name: "other", status: { code: 3, message: "x" } };
    h.runQuery.mockResolvedValue(statusRow([other, HEALTHY_STANZA]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza!.name).toBe("supabase");
    expect(snap!.stanza!.statusCode).toBe(0);
  });

  test("tolerates a stringified jsonb payload", async () => {
    h.runQuery.mockResolvedValue(statusRow(JSON.stringify([HEALTHY_STANZA])));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza!.name).toBe("supabase");
    expect(snap!.stanza!.backups).toHaveLength(3);
  });

  test("garbage payload → snapshot with null stanza (raw preserved)", async () => {
    h.runQuery.mockResolvedValue(statusRow({ not: "an array" }));
    const snap = await getBackupSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.stanza).toBeNull();
    expect(snap!.raw).toEqual({ not: "an array" });
  });

  test("finite but out-of-range epochs degrade to null timestamps, never a throw", async () => {
    // |epoch seconds| > 8.64e12 puts the derived ms value outside the
    // ECMAScript Date range: toISOString() would throw RangeError('Invalid
    // time value') and 500 the refresh route. A poisoned payload (corrupt
    // reporter output, or a SQL-editor write) must degrade like any other
    // malformed field — row kept, timestamps null.
    const poisoned = {
      ...HEALTHY_STANZA,
      backup: [
        {
          ...FULL_BACKUP,
          timestamp: { start: 9e12, stop: 99999999999999 },
        },
        { ...INCR_BACKUP, timestamp: { start: -9e12, stop: 1785808803 } },
      ],
    };
    h.runQuery.mockResolvedValue(statusRow([poisoned]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza).not.toBeNull();
    const [full, incr] = snap!.stanza!.backups;
    expect(full.label).toBe("20260802-020001F");
    expect(full.startedAt).toBeNull();
    expect(full.stoppedAt).toBeNull();
    expect(incr.startedAt).toBeNull();
    expect(incr.stoppedAt).toBe(new Date(1785808803 * 1000).toISOString());
  });

  test("malformed backup entries are dropped, valid ones kept", async () => {
    const messy = {
      ...HEALTHY_STANZA,
      backup: [FULL_BACKUP, { type: "weird", label: "x" }, "junk", { label: 42 }],
    };
    h.runQuery.mockResolvedValue(statusRow([messy]));
    const snap = await getBackupSnapshot();
    expect(snap!.stanza!.backups.map((b) => b.label)).toEqual(["20260802-020001F"]);
  });

  test("empty table → null (host reporter not installed)", async () => {
    h.runQuery.mockResolvedValue([]);
    expect(await getBackupSnapshot()).toBeNull();
  });

  test("missing table → null (migration not applied), not a throw", async () => {
    h.runQuery.mockRejectedValue(
      new Error(
        '[console:pgmeta] query failed: 400: relation "marketinghub.backup_status" does not exist',
      ),
    );
    expect(await getBackupSnapshot()).toBeNull();
  });

  test("other pg-meta errors still fail loud", async () => {
    h.runQuery.mockRejectedValue(
      new Error("[console:pgmeta] query failed: timed out after 30000 ms"),
    );
    await expect(getBackupSnapshot()).rejects.toThrow(/timed out/);
  });
});

describe("getLastArchivedAt", () => {
  test("reads pg_stat_archiver.last_archived_time", async () => {
    h.runQuery.mockResolvedValue([
      { last_archived_time: "2026-08-08 12:34:56+00" },
    ]);
    expect(await getLastArchivedAt()).toBe("2026-08-08 12:34:56+00");
    expect(lastSql()).toContain("from pg_stat_archiver");
  });

  test("null when Postgres has never archived (window unverifiable)", async () => {
    h.runQuery.mockResolvedValue([{ last_archived_time: null }]);
    expect(await getLastArchivedAt()).toBeNull();
  });
});

describe("freshness", () => {
  test("staleness threshold matches three missed 15-minute cron runs", () => {
    expect(STALE_AFTER_MINUTES).toBe(45);
  });
});
