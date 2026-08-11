// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";

import type { WritebackCandidate } from "../lib/monday/writebackRepo";
import {
  buildMondayWritebackConfigFromEnv,
  createMondayWritebackConsumer,
  MONDAY_WRITEBACK_DEFAULTS,
  type MondayWritebackConfig,
  type MondayWritebackDeps,
} from "./monday-writeback";

/**
 * Deterministic consumer tests: every dep is a controllable fake and the
 * clock is frozen. The core contracts under test are ISOLATION (a tick must
 * resolve — never reject — no matter what the repo or the Monday writer do),
 * the warn-once tokenless idle, and the idempotent snapshot skip.
 */

const NOW = new Date("2026-08-11T19:00:00.000Z");

const CONFIG: MondayWritebackConfig = {
  enabled: true,
  pollMs: 60_000,
  batch: 25,
  ratePerSecond: 2,
  maxAttempts: 3,
};

function candidate(over: Partial<WritebackCandidate> = {}): WritebackCandidate {
  return {
    id: "r-1",
    campaignId: "camp-a",
    mondayItemId: "999",
    phoneE164: "+15555550100",
    status: "delivered",
    updatedAt: "2026-08-11T16:00:00+00:00",
    mondaySyncedAt: null,
    mondaySyncedStatus: null,
    boardId: "1111",
    outcomeColumnId: "text_col",
    campaignSendAt: "2026-08-11T15:30:00+00:00",
    ...over,
  };
}

function makeConsumer(
  overrides: Partial<MondayWritebackDeps> = {},
  config: Partial<MondayWritebackConfig> = {},
) {
  const deps = {
    isConfigured: vi.fn((): boolean => true),
    listCandidates: vi.fn(
      async (_limit: number): Promise<WritebackCandidate[]> => [],
    ),
    repliedRecipientIds: vi.fn(async (_ids: string[]) => new Set<string>()),
    suppressionCreatedAt: vi.fn(
      async (_phones: Array<string | null>) => new Map<string, string>(),
    ),
    write: vi.fn(async (): Promise<void> => {}),
    markSynced: vi.fn(async (): Promise<void> => {}),
    markVerified: vi.fn(async (): Promise<void> => {}),
    markAttemptFailed: vi.fn(async (): Promise<void> => {}),
    log: vi.fn((_record: Record<string, unknown>): void => {}),
    now: () => NOW,
  };
  // Mutate-in-place so `deps` keeps its mock types while tests still see
  // their injected overrides through it.
  Object.assign(deps, overrides);
  const consumer = createMondayWritebackConsumer({ ...CONFIG, ...config }, deps);
  return { consumer, deps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildMondayWritebackConfigFromEnv", () => {
  test("returns the documented defaults when nothing is set", () => {
    expect(buildMondayWritebackConfigFromEnv({})).toEqual({
      enabled: true,
      pollMs: 60_000,
      batch: 25,
      ratePerSecond: 2,
      maxAttempts: 3,
    });
    expect(MONDAY_WRITEBACK_DEFAULTS.pollMs).toBe(60_000);
  });

  test("honors env overrides", () => {
    expect(
      buildMondayWritebackConfigFromEnv({
        MONDAY_WRITEBACK_ENABLED: "false",
        MONDAY_WRITEBACK_POLL_INTERVAL_MS: "5000",
        MONDAY_WRITEBACK_BATCH: "10",
        MONDAY_WRITEBACK_RATE_PER_SEC: "0.5",
        MONDAY_WRITEBACK_MAX_ATTEMPTS: "5",
      }),
    ).toEqual({
      enabled: false,
      pollMs: 5_000,
      batch: 10,
      ratePerSecond: 0.5,
      maxAttempts: 5,
    });
  });

  test("MONDAY_WRITEBACK_ENABLED: only explicit false-y tokens disable", () => {
    for (const raw of ["false", "FALSE", "0", "no", "off", " Off "]) {
      expect(
        buildMondayWritebackConfigFromEnv({ MONDAY_WRITEBACK_ENABLED: raw })
          .enabled,
      ).toBe(false);
    }
    for (const raw of [undefined, "", "true", "1", "yes", "banana"]) {
      expect(
        buildMondayWritebackConfigFromEnv({ MONDAY_WRITEBACK_ENABLED: raw })
          .enabled,
      ).toBe(true);
    }
  });

  test("batch is bounded at 200 (a tick's Monday writes must stay boundable)", () => {
    expect(
      buildMondayWritebackConfigFromEnv({ MONDAY_WRITEBACK_BATCH: "10000" })
        .batch,
    ).toBe(200);
  });

  test("fractional counts fall back; fractional JS-only values pass", () => {
    expect(
      buildMondayWritebackConfigFromEnv({
        MONDAY_WRITEBACK_BATCH: "2.5",
        MONDAY_WRITEBACK_MAX_ATTEMPTS: "1.5",
        MONDAY_WRITEBACK_POLL_INTERVAL_MS: "250.5",
        MONDAY_WRITEBACK_RATE_PER_SEC: "0.25",
      }),
    ).toEqual({
      enabled: true,
      pollMs: 250.5,
      batch: 25,
      ratePerSecond: 0.25,
      maxAttempts: 3,
    });
  });

  test("non-numeric / non-positive values fall back to the defaults", () => {
    expect(
      buildMondayWritebackConfigFromEnv({
        MONDAY_WRITEBACK_POLL_INTERVAL_MS: "soon",
        MONDAY_WRITEBACK_BATCH: "-1",
        MONDAY_WRITEBACK_RATE_PER_SEC: "",
        MONDAY_WRITEBACK_MAX_ATTEMPTS: "lots",
      }),
    ).toEqual(MONDAY_WRITEBACK_DEFAULTS);
  });
});

describe("tick — tokenless idle (warn once, never crash)", () => {
  test("MONDAY_API_TOKEN unset: warns exactly once across ticks, never queries", async () => {
    const { consumer, deps } = makeConsumer({
      isConfigured: vi.fn(() => false),
    });

    await consumer.tick();
    await consumer.tick();

    expect(deps.listCandidates).not.toHaveBeenCalled();
    const warns = deps.log.mock.calls.filter(([record]) =>
      String((record as Record<string, unknown>).msg).includes(
        "MONDAY_API_TOKEN is not set",
      ),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ level: "warn" });
  });

  test("the warn-once latch re-arms after the token appears and vanishes again", async () => {
    let configured = false;
    const { consumer, deps } = makeConsumer({
      isConfigured: vi.fn(() => configured),
    });

    await consumer.tick(); // warns
    configured = true;
    await consumer.tick(); // token present — resets the latch
    configured = false;
    await consumer.tick(); // warns again

    const warns = deps.log.mock.calls.filter(([record]) =>
      String((record as Record<string, unknown>).msg).includes(
        "MONDAY_API_TOKEN is not set",
      ),
    );
    expect(warns).toHaveLength(2);
  });
});

describe("tick — write path", () => {
  test("a never-synced row writes the derived outcome and watermarks it", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [candidate()]),
    });

    const stats = await consumer.tick();

    expect(deps.listCandidates).toHaveBeenCalledWith(CONFIG.batch);
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write).toHaveBeenCalledWith({
      boardId: "1111",
      itemId: "999",
      columnId: "text_col",
      value: "delivered 2026-08-11",
    });
    expect(deps.markSynced).toHaveBeenCalledWith(
      "r-1",
      "delivered 2026-08-11",
      NOW,
    );
    expect(deps.markVerified).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      skipped: false,
      candidates: 1,
      written: 1,
      unchanged: 0,
      errors: [],
    });

    // Exactly one JSON log line for a tick that wrote.
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "monday-writeback tick", written: 1 }),
    );
  });

  test("an outcome drift (delivery report landed) re-writes over the stale snapshot", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({
          mondaySyncedAt: "2026-08-10T19:00:00+00:00",
          mondaySyncedStatus: "sent 2026-08-10",
        }),
      ]),
    });

    const stats = await consumer.tick();

    expect(deps.write).toHaveBeenCalledWith(
      expect.objectContaining({ value: "delivered 2026-08-11" }),
    );
    expect(stats.written).toBe(1);
  });

  test("replied and opted-out enrichment reach the written value", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({ id: "r-replied", mondayItemId: "1" }),
        candidate({
          id: "r-optout",
          mondayItemId: "2",
          phoneE164: "+15555550199",
        }),
      ]),
      repliedRecipientIds: vi.fn(async () => new Set(["r-replied"])),
      suppressionCreatedAt: vi.fn(
        async () =>
          new Map([["+15555550199", "2026-08-11T18:00:00+00:00"]]),
      ),
    });

    await consumer.tick();

    expect(deps.repliedRecipientIds).toHaveBeenCalledWith([
      "r-replied",
      "r-optout",
    ]);
    expect(deps.suppressionCreatedAt).toHaveBeenCalledWith([
      "+15555550100",
      "+15555550199",
    ]);
    expect(deps.write).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "1", value: "replied" }),
    );
    expect(deps.write).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "2", value: "opted out" }),
    );
  });
});

describe("tick — idempotent re-sync skip", () => {
  test("outcome == synced snapshot: no Monday call, watermark bump only, silent tick", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({
          mondaySyncedAt: "2026-08-11T18:00:00+00:00",
          mondaySyncedStatus: "delivered 2026-08-11",
        }),
      ]),
    });

    const stats = await consumer.tick();

    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.markSynced).not.toHaveBeenCalled();
    // The round-robin liveness bump — checked rows go to the back of the queue.
    expect(deps.markVerified).toHaveBeenCalledWith(["r-1"], NOW);
    expect(stats).toMatchObject({ candidates: 1, written: 0, unchanged: 1 });
    // Verified-only ticks are silent (at rest this runs forever).
    expect(deps.log).not.toHaveBeenCalled();
  });

  test("an empty candidate list is silent and calls nothing", async () => {
    const { consumer, deps } = makeConsumer();

    const stats = await consumer.tick();

    expect(stats).toMatchObject({ candidates: 0, written: 0, unchanged: 0 });
    expect(deps.repliedRecipientIds).not.toHaveBeenCalled();
    expect(deps.markVerified).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });
});

describe("tick — CSV-campaign exclusion", () => {
  test("the consumer only writes what the repo yields — CSV campaigns are excluded SQL-side, so an empty yield writes nothing", async () => {
    // A CSV campaign (monday_board_id null) never becomes a candidate:
    // listWritebackCandidates filters it in its campaigns query (covered in
    // writebackRepo.test.ts). The consumer's contract is to touch ONLY
    // yielded candidates.
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => []),
    });

    await consumer.tick();

    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.markSynced).not.toHaveBeenCalled();
    expect(deps.markVerified).not.toHaveBeenCalled();
  });
});

describe("tick — isolation (a consumer error NEVER propagates)", () => {
  test("a failing write is recorded and the rest of the batch still syncs", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({ id: "r-bad", mondayItemId: "1" }),
        candidate({ id: "r-good", mondayItemId: "2" }),
      ]),
      write: vi
        .fn(async () => {})
        .mockRejectedValueOnce(
          new Error("Monday GraphQL error: column not found"),
        ),
    });

    const stats = await consumer.tick();

    expect(stats.written).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("r-bad");
    expect(stats.errors[0]).toContain("column not found");
    // The failed row's SNAPSHOT is untouched (it stays a candidate)…
    expect(deps.markSynced).toHaveBeenCalledTimes(1);
    expect(deps.markSynced).toHaveBeenCalledWith(
      "r-good",
      expect.any(String),
      NOW,
    );
    // …but its QUEUE watermark is bumped, so it rotates to the back instead
    // of pinning the round-robin head forever (>= batch permanently-failing
    // rows would otherwise starve every other campaign).
    expect(deps.markAttemptFailed).toHaveBeenCalledTimes(1);
    expect(deps.markAttemptFailed).toHaveBeenCalledWith("r-bad", NOW);
  });

  test("a Monday 401/403 bumps the failed row, aborts the rest of the tick, and warns about token scope", async () => {
    const authError = new Error("Monday API HTTP 403: forbidden");
    authError.name = "MondayApiError";
    (authError as unknown as { status: number }).status = 403;
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({ id: "r-1", mondayItemId: "1" }),
        candidate({ id: "r-2", mondayItemId: "2" }),
      ]),
      write: vi.fn(async () => {
        throw authError;
      }),
    });

    const stats = await consumer.tick();

    // Auth is global — one probe, not a doomed mutation per candidate.
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(stats.errors).toHaveLength(1);
    // The probed row still rotates to the back (liveness under a bad token).
    expect(deps.markAttemptFailed).toHaveBeenCalledWith("r-1", NOW);
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        msg: expect.stringContaining("WRITE scope"),
      }),
    );
  });

  test("a MondayConfigError mid-batch stops the batch (nothing else can write)", async () => {
    const configError = new Error("MONDAY_API_TOKEN is not set");
    configError.name = "MondayConfigError";
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({ id: "r-1", mondayItemId: "1" }),
        candidate({ id: "r-2", mondayItemId: "2" }),
      ]),
      write: vi.fn(async () => {
        throw configError;
      }),
    });

    const stats = await consumer.tick();

    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(stats.errors).toHaveLength(1);
    // Token vanished — a global condition, not a row's fault: no queue bump.
    expect(deps.markAttemptFailed).not.toHaveBeenCalled();
  });

  test("a markAttemptFailed failure is recorded too and the batch continues", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [
        candidate({ id: "r-bad", mondayItemId: "1" }),
        candidate({ id: "r-good", mondayItemId: "2" }),
      ]),
      write: vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error("item not found")),
      markAttemptFailed: vi.fn(async () => {
        throw new Error("postgrest down");
      }),
    });

    const stats = await consumer.tick();

    expect(stats.written).toBe(1);
    expect(stats.errors).toHaveLength(2);
    expect(stats.errors[1]).toContain("attempt bump failed");
    expect(deps.markSynced).toHaveBeenCalledWith(
      "r-good",
      expect.any(String),
      NOW,
    );
  });

  test("a markSynced failure after a confirmed write is recorded — the identical re-write next tick is safe", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => [candidate()]),
      markSynced: vi.fn(async () => {
        throw new Error("postgrest down");
      }),
    });

    const stats = await consumer.tick();

    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(stats.written).toBe(0);
    expect(stats.errors[0]).toContain("postgrest down");
  });

  test("listCandidates rejecting resolves the tick with the error logged", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });

    await expect(consumer.tick()).resolves.toMatchObject({
      candidates: 0,
      errors: ["socket hang up"],
    });
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", error: "socket hang up" }),
    );
  });

  test("isConfigured throwing synchronously resolves the tick", async () => {
    const { consumer, deps } = makeConsumer({
      isConfigured: vi.fn(() => {
        throw new Error("env exploded");
      }),
    });

    await expect(consumer.tick()).resolves.toMatchObject({
      errors: ["env exploded"],
    });
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", error: "env exploded" }),
    );
  });
});

describe("tick — busy flag (no overlapping ticks)", () => {
  test("a second tick during a slow first tick is skipped without touching the repo", async () => {
    let release: () => void = () => {};
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(
        () =>
          new Promise<WritebackCandidate[]>((resolve) => {
            release = () => resolve([]);
          }),
      ),
    });

    const first = consumer.tick();
    const second = await consumer.tick();

    expect(second.skipped).toBe(true);
    expect(deps.listCandidates).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ skipped: false });
  });

  test("repeated consecutive skips warn periodically (a wedged tick is observable)", async () => {
    const { consumer, deps } = makeConsumer({
      listCandidates: vi.fn(() => new Promise<WritebackCandidate[]>(() => {})),
    });

    void consumer.tick(); // wedges forever
    for (let i = 0; i < 10; i++) await consumer.tick();

    const warns = deps.log.mock.calls.filter(([record]) =>
      String((record as Record<string, unknown>).msg).includes(
        "previous tick still running",
      ),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ level: "warn", consecutiveSkips: 10 });
  });
});

describe("start/stop — the consumer's own interval", () => {
  test("start ticks immediately, then on its own interval; stop halts it", async () => {
    vi.useFakeTimers();
    const { consumer, deps } = makeConsumer();
    const polls = () => deps.listCandidates.mock.calls.length;

    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls()).toBe(1); // immediate first pass

    await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    expect(polls()).toBe(2);

    consumer.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs * 3);
    expect(polls()).toBe(2);
  });

  test("start is idempotent (a second start never doubles the interval)", async () => {
    vi.useFakeTimers();
    const { consumer, deps } = makeConsumer();

    consumer.start();
    consumer.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    expect(deps.listCandidates).toHaveBeenCalledTimes(2);
  });

  test("MONDAY_WRITEBACK_ENABLED=false: start logs the disabled warning and never polls", async () => {
    vi.useFakeTimers();
    const { consumer, deps } = makeConsumer({}, { enabled: false });

    consumer.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs * 2);

    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        msg: expect.stringContaining("disabled"),
      }),
    );
  });
});
