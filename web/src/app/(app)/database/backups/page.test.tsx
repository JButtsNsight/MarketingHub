import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { BackupSnapshot } from "@/lib/console/backups";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
  getBackupSnapshot: vi.fn(),
  getLastArchivedAt: vi.fn(),
}));

// The page is gated server-side on the marketing group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// requireMarketingUser.test.ts).
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// Mock the server-only backups lib; the page's honest-degradation branches
// are the unit under test.
vi.mock("@/lib/console/backups", () => ({
  getBackupSnapshot: h.getBackupSnapshot,
  getLastArchivedAt: h.getLastArchivedAt,
  STALE_AFTER_MINUTES: 45,
}));

import BackupsPage from "./page";

const AMY = { email: "amy@nsight.example", name: "Amy", groups: ["marketing"] };

/** A fresh (captured moments ago) healthy snapshot fixture. */
function freshSnapshot(): BackupSnapshot {
  return {
    capturedAt: new Date(Date.now() - 60_000).toISOString(),
    stanza: {
      name: "supabase",
      statusCode: 0,
      statusMessage: "ok",
      backupLockHeld: false,
      backups: [
        {
          label: "20260802-020001F",
          type: "full",
          startedAt: "2026-08-02T02:00:01.000Z",
          stoppedAt: "2026-08-02T02:12:31.000Z",
          dbSizeBytes: 1073741824,
          repoSizeBytes: 268435456,
          error: false,
          prior: null,
          reference: null,
        },
      ],
      archiveMin: "000000010000000000000001",
      archiveMax: "0000000100000000000000AB",
    },
    raw: [],
  };
}

describe("database/backups/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireMarketingUser.mockReset().mockResolvedValue(AMY);
    h.getBackupSnapshot.mockReset().mockResolvedValue(freshSnapshot());
    h.getLastArchivedAt
      .mockReset()
      .mockResolvedValue("2026-08-08T14:00:00.000Z");
  });

  test("enforces the marketing gate and renders a fresh snapshot", async () => {
    render(await BackupsPage());

    expect(h.requireMarketingUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Backups", level: 1 }),
    ).toBeInTheDocument();

    // Stanza summary + the backup row from the fixture.
    expect(screen.getByText("stanza ok")).toBeInTheDocument();
    expect(screen.getByText("20260802-020001F")).toBeInTheDocument();
    // Archiver cross-check made it down to the PITR band.
    expect(screen.getByText("2026-08-08 14:00 UTC")).toBeInTheDocument();
    // Fresh capture: no staleness warning.
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  test("null snapshot renders the honest 'host reporter not installed' empty state", async () => {
    h.getBackupSnapshot.mockResolvedValue(null);
    render(await BackupsPage());

    expect(screen.getByText("Backup status unreachable")).toBeInTheDocument();
    expect(
      screen.getByText(/host reporter cron is not installed/),
    ).toBeInTheDocument();
    // Runbook §12 pointer for the installer.
    expect(
      screen.getByText(/§12 of docs\/runbooks\/marketinghub-app-deploy\.md/),
    ).toBeInTheDocument();
    // No snapshot ⇒ no PITR window to cross-check.
    expect(h.getLastArchivedAt).not.toHaveBeenCalled();
  });

  test("a throwing snapshot read (pg-meta down) degrades to the same empty state, not a 500", async () => {
    h.getBackupSnapshot.mockRejectedValue(
      new Error("[console:pgmeta] query failed: connection refused"),
    );
    render(await BackupsPage());

    expect(screen.getByText("Backup status unreachable")).toBeInTheDocument();
    expect(h.getLastArchivedAt).not.toHaveBeenCalled();
  });

  test("a failing archiver cross-check still renders the backups with an unverifiable PITR end", async () => {
    h.getLastArchivedAt.mockRejectedValue(
      new Error("[console:pgmeta] query failed: connection refused"),
    );
    render(await BackupsPage());

    expect(screen.getByText("20260802-020001F")).toBeInTheDocument();
    expect(
      screen.getByText(/archiving unverifiable — no archived WAL recorded/),
    ).toBeInTheDocument();
  });
});
