import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BackupsClient } from "./BackupsClient";
import type { BackupRow, BackupSnapshot, StanzaInfo } from "@/lib/console/backups";

/** The threshold the server page passes down (STALE_AFTER_MINUTES). */
const STALE_AFTER = 45;

const FULL: BackupRow = {
  label: "20260802-020001F",
  type: "full",
  startedAt: "2026-08-02T02:00:01.000Z",
  stoppedAt: "2026-08-02T02:12:31.000Z", // 12m 30s
  dbSizeBytes: 1073741824, // 1.0 GB
  repoSizeBytes: 268435456, // 256.0 MB
  error: false,
  prior: null,
  reference: null,
};

const DIFF: BackupRow = {
  label: "20260802-020001F_20260807-020003D",
  type: "diff",
  startedAt: "2026-08-07T02:00:03.000Z",
  stoppedAt: "2026-08-07T02:01:33.000Z", // 1m 30s
  dbSizeBytes: 1181116006,
  repoSizeBytes: 52428800, // 50.0 MB
  error: false,
  prior: "20260802-020001F",
  reference: ["20260802-020001F"],
};

function makeStanza(overrides: Partial<StanzaInfo> = {}): StanzaInfo {
  return {
    name: "supabase",
    statusCode: 0,
    statusMessage: "ok",
    backupLockHeld: false,
    backups: [FULL, DIFF], // pgBackRest order: oldest → newest
    archiveMin: "000000010000000000000001",
    archiveMax: "0000000100000000000000AB",
    ...overrides,
  };
}

/** capturedAt defaults to five minutes ago — comfortably fresh. */
function makeSnapshot(overrides: Partial<BackupSnapshot> = {}): BackupSnapshot {
  return {
    capturedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    stanza: makeStanza(),
    raw: [],
    ...overrides,
  };
}

const LAST_ARCHIVED = "2026-08-08T14:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BackupsClient", () => {
  test("fresh snapshot: stanza status, backup rows, PITR window — and no stale warning", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot()}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );

    // Stanza summary: ok pill from status.code, no lock badge.
    expect(screen.getByText("stanza ok")).toBeInTheDocument();
    expect(screen.queryByText("backup in progress")).not.toBeInTheDocument();
    expect(screen.getByText("1 full · 1 diff · 0 incr")).toBeInTheDocument();

    // Backup rows: labels, type badges, finished, duration, sizes, checksum.
    expect(screen.getByText("20260802-020001F")).toBeInTheDocument();
    expect(
      screen.getByText("20260802-020001F_20260807-020003D"),
    ).toBeInTheDocument();
    expect(screen.getByText("full")).toBeInTheDocument();
    expect(screen.getByText("diff")).toBeInTheDocument();
    expect(screen.getByText("12m 30s")).toBeInTheDocument();
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    expect(screen.getByText("256.0 MB")).toBeInTheDocument();
    // Diff-row repo size + the "Repository size (latest set)" stat card.
    expect(screen.getAllByText("50.0 MB")).toHaveLength(2);
    expect(screen.getAllByText("clean")).toHaveLength(2);

    // PITR band: oldest stop → last archived WAL, plus segment-name range.
    expect(screen.getByText("Earliest restorable")).toBeInTheDocument();
    // Full backup's finished cell + the PITR "earliest restorable" value.
    expect(screen.getAllByText("2026-08-02 02:12 UTC")).toHaveLength(2);
    expect(screen.getByText("2026-08-08 14:00 UTC")).toBeInTheDocument();
    expect(
      screen.getByText("000000010000000000000001 → 0000000100000000000000AB"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/archiving unverifiable/)).not.toBeInTheDocument();

    // Fresh: no staleness warning.
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();

    // Restore drill is a read-only pointer, never an action.
    expect(screen.getByText(/restore-drill\.md/)).toBeInTheDocument();
    expect(screen.getByText(/RPO ≤ 5 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/RTO < 2 hours/)).toBeInTheDocument();
    // No last-drill date claim — only the honest "not tracked" note.
    expect(screen.getByText(/drill history is not derivable/)).toBeInTheDocument();

    // The ONLY button on the whole surface is Refresh — no trigger/restore.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Refresh");
  });

  test("stale capturedAt (past the threshold) shows the freshness warning", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({
          capturedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
        })}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.getByText(/stale — reported 5\d min ago/)).toBeInTheDocument();
  });

  test("capturedAt exactly at the threshold is NOT stale (strictly past only)", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({
          capturedAt: new Date(Date.now() - STALE_AFTER * 60_000).toISOString(),
        })}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  test("empty backups list renders the honest empty row and no PITR earliest", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({ stanza: makeStanza({ backups: [] }) })}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(
      screen.getByText(/No completed backups reported yet/),
    ).toBeInTheDocument();
    expect(screen.getByText("0 full · 0 diff · 0 incr")).toBeInTheDocument();
    // Earliest restorable can't be claimed without a completed set.
    expect(screen.getByText("Earliest restorable")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  test("a broken stanza (status.code != 0) is surfaced honestly, not hidden", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({
          stanza: makeStanza({
            statusCode: 1,
            statusMessage: "missing stanza path",
            backups: [],
          }),
        })}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.getByText(/missing stanza path/)).toBeInTheDocument();
    expect(screen.getByText(/code 1/)).toBeInTheDocument();
    expect(screen.queryByText("stanza ok")).not.toBeInTheDocument();
  });

  test("a held backup lock shows the in-progress badge", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({
          stanza: makeStanza({ backupLockHeld: true }),
        })}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.getByText("backup in progress")).toBeInTheDocument();
  });

  test("null lastArchivedAt warns that archiving is unverifiable", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot()}
        initialLastArchivedAt={null}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(
      screen.getByText(/archiving unverifiable — no archived WAL recorded/),
    ).toBeInTheDocument();
  });

  test("a payload with no parseable stanza renders the unreadable state", () => {
    render(
      <BackupsClient
        initialSnapshot={makeSnapshot({ stanza: null })}
        initialLastArchivedAt={null}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.getByText("Status payload unreadable")).toBeInTheDocument();
  });

  test("Refresh re-reads /api/console/backups and re-renders the new snapshot", async () => {
    const next: BackupSnapshot = makeSnapshot({
      stanza: makeStanza({ backupLockHeld: true }),
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ snapshot: next, lastArchivedAt: null }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <BackupsClient
        initialSnapshot={makeSnapshot()}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    expect(screen.queryByText("backup in progress")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/console/backups");
    expect(await screen.findByText("backup in progress")).toBeInTheDocument();
    expect(
      screen.getByText(/archiving unverifiable — no archived WAL recorded/),
    ).toBeInTheDocument();
  });

  test("a failed refresh shows the error without discarding the shown snapshot", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "pg-meta exploded" }), {
          status: 400,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <BackupsClient
        initialSnapshot={makeSnapshot()}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pg-meta exploded");
    expect(screen.getByText("20260802-020001F")).toBeInTheDocument();
  });

  test("a refresh that finds the status row gone renders the unreachable state", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ snapshot: null, lastArchivedAt: null }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <BackupsClient
        initialSnapshot={makeSnapshot()}
        initialLastArchivedAt={LAST_ARCHIVED}
        staleAfterMinutes={STALE_AFTER}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("Backup status unreachable"),
    ).toBeInTheDocument();
    expect(screen.getByText(/host reporter cron is not installed/)).toBeInTheDocument();
  });
});
