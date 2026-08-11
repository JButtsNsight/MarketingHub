// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CampaignStatus, SmsCampaignRecipient } from "../lib/sms/schema";
import type { SendResult, SendSmsInput } from "../lib/simpletexting/client";
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherConfig,
  type DispatcherDeps,
} from "./dispatcher";

/**
 * Deterministic dispatcher tests: every dependency (repo fns, sendSms, sleep,
 * now) is injected as a fake that appends to a single ordered call log, so a
 * test can assert the EXACT sequence of a tick — including throttle gaps —
 * without real timers or network.
 */

const CONFIG: DispatcherConfig = {
  pollMs: 30_000,
  batchSize: 25,
  claimTtlSeconds: 180,
  ratePerSecond: 2, // → 500 ms throttle gap between POSTs
  maxAttempts: 3,
  frequencyCapCount: 0,
  frequencyCapDays: 0,
};

/** Frozen "now" for every test — backoff instants are asserted as deltas. */
const NOW = new Date("2026-07-22T15:30:00.000Z");

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function makeRow(
  overrides: Partial<SmsCampaignRecipient> = {},
): SmsCampaignRecipient {
  seq += 1;
  return {
    id: `r-${seq}`,
    campaign_id: "c-1",
    monday_item_id: `item-${seq}`,
    name: "Pat Example",
    first_name: "Pat",
    phone_e164: `+1555000${String(seq).padStart(4, "0")}`,
    rendered_text: `Hi Pat, message ${seq}.`,
    status: "claimed",
    attempts: 0,
    send_after: NOW.toISOString(),
    send_timezone: null,
    claimed_at: NOW.toISOString(),
    claim_expires_at: new Date(NOW.getTime() + 180_000).toISOString(),
    st_message_id: null,
    st_credits: null,
    last_error: null,
    monday_synced_at: null,
    monday_synced_status: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

interface HarnessOptions {
  /** Ids returned by promoteDueCampaigns. */
  promoted?: string[];
  /** Successive claim batches; claims past the end return []. */
  batches?: SmsCampaignRecipient[][];
  /** Campaign status overrides (default: every id is 'sending'). */
  statuses?: Record<string, CampaignStatus>;
  /** Phones the belt-and-suspenders isSuppressed check reports as STOPped. */
  suppressedPhones?: string[];
  /** Recipient ids whose markSending returns null (lost the claimed guard). */
  markSendingLosers?: string[];
  /** SendResult per phone (default: sent, id "st-123", credits 2). */
  results?: Record<string, SendResult>;
  /** Hook invoked when a POST starts (used to trigger mid-batch shutdown). */
  onSend?: (input: SendSmsInput) => void;
  /** Ids returned by completeDrainedCampaigns. */
  drained?: string[];
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: string[] = [];
  const batches = opts.batches ?? [[]];
  let batchIndex = 0;

  const deps: DispatcherDeps = {
    promoteDueCampaigns: vi.fn(async (now: Date) => {
      calls.push(`promote(${now.toISOString()})`);
      return opts.promoted ?? [];
    }),
    claimDueRecipients: vi.fn(async (batchSize: number, ttl: number) => {
      calls.push(`claim(${batchSize},${ttl})`);
      const batch = batches[batchIndex] ?? [];
      batchIndex += 1;
      return batch;
    }),
    getCampaignStatuses: vi.fn(async (ids: string[]) => {
      calls.push(`statuses(${Array.from(new Set(ids)).join("|")})`);
      const map = new Map<string, CampaignStatus>();
      for (const id of ids) map.set(id, opts.statuses?.[id] ?? "sending");
      return map;
    }),
    isSuppressed: vi.fn(async (phone: string) => {
      calls.push(`isSuppressed(${phone})`);
      return (opts.suppressedPhones ?? []).includes(phone);
    }),
    suppressActiveRecipientsByPhone: vi.fn(async (phone: string) => {
      calls.push(`suppressPhone(${phone})`);
      return 1;
    }),
    markSending: vi.fn(async (id: string, nextAttempts: number) => {
      calls.push(`markSending(${id},${nextAttempts})`);
      if ((opts.markSendingLosers ?? []).includes(id)) return null;
      return makeRow({ id, status: "sending", attempts: nextAttempts });
    }),
    markSent: vi.fn(
      async (
        id: string,
        result: { stMessageId: string | null; stCredits: number | null },
      ) => {
        calls.push(`markSent(${id},${result.stMessageId},${result.stCredits})`);
        return makeRow({ id, status: "sent" });
      },
    ),
    markFailed: vi.fn(async (id: string, _detail: string) => {
      calls.push(`markFailed(${id})`);
      return makeRow({ id, status: "failed" });
    }),
    markRetry: vi.fn(async (id: string, sendAfter: Date, _detail: string) => {
      calls.push(`markRetry(${id},+${sendAfter.getTime() - NOW.getTime()}ms)`);
      return makeRow({ id, status: "pending" });
    }),
    markAmbiguous: vi.fn(async (id: string, _detail: string) => {
      calls.push(`markAmbiguous(${id})`);
      return makeRow({ id, status: "failed_ambiguous" });
    }),
    releaseClaim: vi.fn(async (id: string) => {
      calls.push(`releaseClaim(${id})`);
      return makeRow({ id, status: "pending" });
    }),
    releaseForConfigError: vi.fn(
      async (id: string, revertAttempts: number, _detail: string) => {
        calls.push(`releaseConfig(${id},${revertAttempts})`);
        return makeRow({ id, status: "pending", attempts: revertAttempts });
      },
    ),
    completeDrainedCampaigns: vi.fn(async () => {
      calls.push("complete");
      return opts.drained ?? [];
    }),
    sendSms: vi.fn(async (input: SendSmsInput) => {
      calls.push(`send(${input.phone})`);
      opts.onSend?.(input);
      return (
        opts.results?.[input.phone] ?? {
          kind: "sent" as const,
          id: "st-123",
          credits: 2,
        }
      );
    }),
    sleep: vi.fn(async (ms: number) => {
      calls.push(`sleep(${ms})`);
    }),
    now: () => NOW,
  };

  return { deps, calls };
}

describe("createDispatcher tick — core drain loop", () => {
  test("promotes due campaigns (with now) before claiming", async () => {
    const h = makeHarness({ promoted: ["c-1", "c-2"] });
    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.promoteDueCampaigns).toHaveBeenCalledWith(NOW);
    expect(stats.promoted).toBe(2);
    expect(h.calls.indexOf(`promote(${NOW.toISOString()})`)).toBeLessThan(
      h.calls.indexOf("claim(25,180)"),
    );
  });

  test("claims → statuses once per batch → markSending(attempts+1) → send → markSent, with a throttle gap between POSTs", async () => {
    const r1 = makeRow(); // r-1, attempts 0
    const r2 = makeRow({ attempts: 1 }); // r-2
    const h = makeHarness({ batches: [[r1, r2], []] });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.sendSms).toHaveBeenCalledWith({
      phone: r1.phone_e164,
      text: r1.rendered_text,
    });
    expect(h.calls).toEqual([
      `promote(${NOW.toISOString()})`,
      "claim(25,180)",
      "statuses(c-1)",
      `isSuppressed(${r1.phone_e164})`,
      "markSending(r-1,1)",
      `send(${r1.phone_e164})`,
      "markSent(r-1,st-123,2)",
      "sleep(500)",
      `isSuppressed(${r2.phone_e164})`,
      "markSending(r-2,2)",
      `send(${r2.phone_e164})`,
      "markSent(r-2,st-123,2)",
      "sleep(500)",
      "claim(25,180)",
      "complete",
    ]);
    expect(stats.claimed).toBe(2);
    expect(stats.sent).toBe(2);
  });

  test("keeps draining until a claim comes back empty", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const h = makeHarness({ batches: [[r1], [r2], []] });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.claimDueRecipients).toHaveBeenCalledTimes(3);
    expect(h.deps.sendSms).toHaveBeenCalledTimes(2);
    expect(stats.sent).toBe(2);
  });

  test("passes the frequency-cap config through to the claim call", async () => {
    const h = makeHarness();

    await createDispatcher(h.deps, {
      ...CONFIG,
      frequencyCapCount: 2,
      frequencyCapDays: 7,
    }).tick();

    expect(h.deps.claimDueRecipients).toHaveBeenCalledWith(25, 180, 2, 7);
  });

  test("empty first claim: no statuses fetch, no sends, still completes drained campaigns", async () => {
    const h = makeHarness({ batches: [[]], drained: ["c-9"] });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.claimDueRecipients).toHaveBeenCalledTimes(1);
    expect(h.deps.getCampaignStatuses).not.toHaveBeenCalled();
    expect(h.deps.sendSms).not.toHaveBeenCalled();
    expect(h.deps.completeDrainedCampaigns).toHaveBeenCalledTimes(1);
    expect(stats.completed).toBe(1);
    expect(h.calls[h.calls.length - 1]).toBe("complete");
  });
});

describe("createDispatcher tick — per-row guards", () => {
  test("releases rows whose campaign is no longer sending (paused mid-batch), no POST", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const h = makeHarness({
      batches: [[r1, r2], []],
      statuses: { "c-1": "paused" },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-1");
    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-2");
    expect(h.deps.markSending).not.toHaveBeenCalled();
    expect(h.deps.sendSms).not.toHaveBeenCalled();
    expect(h.deps.sleep).not.toHaveBeenCalled(); // no POST → no throttle gap
    expect(stats.released).toBe(2);
  });

  test("markSending race loss (claim released under us) skips the row with NO POST", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const h = makeHarness({
      batches: [[r1, r2], []],
      markSendingLosers: ["r-1"],
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.sendSms).toHaveBeenCalledTimes(1);
    expect(h.deps.sendSms).toHaveBeenCalledWith({
      phone: r2.phone_e164,
      text: r2.rendered_text,
    });
    expect(h.deps.markSent).toHaveBeenCalledWith("r-2", {
      stMessageId: "st-123",
      stCredits: 2,
    });
    expect(stats.sent).toBe(1);
  });

  test("belt-and-suspenders: suppressed phone is marked suppressed, never marked sending, never POSTed", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const h = makeHarness({
      batches: [[r1, r2], []],
      suppressedPhones: [r1.phone_e164 as string],
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.suppressActiveRecipientsByPhone).toHaveBeenCalledWith(
      r1.phone_e164,
    );
    expect(h.deps.markSending).not.toHaveBeenCalledWith("r-1", 1);
    expect(h.deps.sendSms).toHaveBeenCalledTimes(1);
    expect(h.deps.sendSms).toHaveBeenCalledWith({
      phone: r2.phone_e164,
      text: r2.rendered_text,
    });
    expect(stats.suppressed).toBe(1);
    expect(stats.sent).toBe(1);
  });

  test("defensive: a claimed row with no phone is failed through markSending (outbox invariant breach), no POST", async () => {
    const r1 = makeRow({ phone_e164: null });
    const h = makeHarness({ batches: [[r1], []] });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markSending).toHaveBeenCalledWith("r-1", 1);
    expect(h.deps.markFailed).toHaveBeenCalledWith(
      "r-1",
      expect.stringContaining("no phone_e164"),
    );
    expect(h.deps.sendSms).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });
});

describe("createDispatcher tick — SendResult classification", () => {
  test("permanent → markFailed with the result detail", async () => {
    const r1 = makeRow();
    const h = makeHarness({
      batches: [[r1], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "permanent",
          status: 422,
          detail: "HTTP 422: bad phone",
        },
      },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markFailed).toHaveBeenCalledWith("r-1", "HTTP 422: bad phone");
    expect(h.deps.markRetry).not.toHaveBeenCalled();
    expect(stats.failed).toBe(1);
  });

  test("retryable first attempt → markRetry with 60s backoff (60s·2^(attempts−1))", async () => {
    const r1 = makeRow({ attempts: 0 });
    const h = makeHarness({
      batches: [[r1], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "retryable",
          status: 429,
          detail: "HTTP 429: slow down",
        },
      },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markRetry).toHaveBeenCalledWith(
      "r-1",
      new Date(NOW.getTime() + 60_000),
      "HTTP 429: slow down",
    );
    expect(stats.retried).toBe(1);
  });

  test("retryable second attempt → markRetry with 120s backoff", async () => {
    const r1 = makeRow({ attempts: 1 });
    const h = makeHarness({
      batches: [[r1], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "retryable",
          status: 503,
          detail: "HTTP 503: unavailable",
        },
      },
    });

    await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markRetry).toHaveBeenCalledWith(
      "r-1",
      new Date(NOW.getTime() + 120_000),
      "HTTP 503: unavailable",
    );
  });

  test("retryable with attempts exhausted (3rd POST) → markFailed, never markRetry", async () => {
    const r1 = makeRow({ attempts: 2 });
    const h = makeHarness({
      batches: [[r1], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "retryable",
          status: 503,
          detail: "HTTP 503: unavailable",
        },
      },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markSending).toHaveBeenCalledWith("r-1", 3);
    expect(h.deps.markRetry).not.toHaveBeenCalled();
    expect(h.deps.markFailed).toHaveBeenCalledWith(
      "r-1",
      expect.stringContaining("HTTP 503: unavailable"),
    );
    expect(stats.failed).toBe(1);
  });

  test("ambiguous → markAmbiguous (never retried)", async () => {
    const r1 = makeRow();
    const h = makeHarness({
      batches: [[r1], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "ambiguous",
          status: null,
          detail: "TimeoutError: timed out",
        },
      },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    expect(h.deps.markAmbiguous).toHaveBeenCalledWith(
      "r-1",
      "TimeoutError: timed out",
    );
    expect(h.deps.markRetry).not.toHaveBeenCalled();
    expect(stats.ambiguous).toBe(1);
  });

  test("config → releaseForConfigError (attempts compensated) + release rest of batch + 5-min backoff + abort tick", async () => {
    const r1 = makeRow({ attempts: 1 });
    const r2 = makeRow();
    const r3 = makeRow();
    const h = makeHarness({
      batches: [
        [r1, r2, r3],
        [makeRow()], // must never be claimed — the tick aborts
      ],
      results: {
        [r1.phone_e164 as string]: {
          kind: "config",
          status: 401,
          detail: "HTTP 401: bad token",
        },
      },
    });

    const stats = await createDispatcher(h.deps, CONFIG).tick();

    // Attempts compensated back to the pre-increment value.
    expect(h.deps.releaseForConfigError).toHaveBeenCalledWith(
      "r-1",
      1,
      "HTTP 401: bad token",
    );
    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-2");
    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-3");
    expect(h.deps.sendSms).toHaveBeenCalledTimes(1); // no POSTs after the abort
    expect(h.deps.claimDueRecipients).toHaveBeenCalledTimes(1);
    // Long backoff, and no 500ms throttle gap for the aborted POST.
    expect(vi.mocked(h.deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([
      300_000,
    ]);
    expect(h.deps.completeDrainedCampaigns).toHaveBeenCalledTimes(1);
    expect(stats.configErrors).toBe(1);
    expect(stats.released).toBe(2);
  });

  test(">50% errors in a batch → 60s backpressure sleep before the next claim", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const r3 = makeRow();
    const h = makeHarness({
      batches: [[r1, r2, r3], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "permanent",
          status: 400,
          detail: "HTTP 400",
        },
        [r2.phone_e164 as string]: {
          kind: "ambiguous",
          status: 500,
          detail: "HTTP 500",
        },
      },
    });

    await createDispatcher(h.deps, CONFIG).tick();

    const lastThrottle = h.calls.lastIndexOf("sleep(500)");
    const backpressure = h.calls.indexOf("sleep(60000)");
    const secondClaim = h.calls.lastIndexOf("claim(25,180)");
    expect(backpressure).toBeGreaterThan(lastThrottle);
    expect(backpressure).toBeLessThan(secondClaim);
  });

  test("errors at or below 50% of a batch → no backpressure sleep", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const h = makeHarness({
      batches: [[r1, r2], []],
      results: {
        [r1.phone_e164 as string]: {
          kind: "permanent",
          status: 400,
          detail: "HTTP 400",
        },
      },
    });

    await createDispatcher(h.deps, CONFIG).tick();

    expect(h.calls).not.toContain("sleep(60000)");
  });
});

describe("createDispatcher — shutdown", () => {
  test("shutdown mid-batch: in-flight POST resolves, remaining claims released, loop exits, no further claim", async () => {
    const r1 = makeRow();
    const r2 = makeRow();
    const r3 = makeRow();
    let dispatcher: Dispatcher | undefined;
    const h = makeHarness({
      batches: [
        [r1, r2, r3],
        [makeRow()], // must never be claimed after shutdown
      ],
      onSend: () => dispatcher?.requestShutdown(),
    });
    dispatcher = createDispatcher(h.deps, CONFIG);

    const stats = await dispatcher.tick();

    // The in-flight POST is never interrupted and still settles its row.
    expect(h.deps.markSent).toHaveBeenCalledWith("r-1", {
      stMessageId: "st-123",
      stCredits: 2,
    });
    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-2");
    expect(h.deps.releaseClaim).toHaveBeenCalledWith("r-3");
    expect(h.deps.sendSms).toHaveBeenCalledTimes(1);
    expect(h.deps.claimDueRecipients).toHaveBeenCalledTimes(1);
    expect(h.deps.completeDrainedCampaigns).toHaveBeenCalledTimes(1);
    expect(dispatcher.isShuttingDown()).toBe(true);
    expect(stats.sent).toBe(1);
    expect(stats.released).toBe(2);
  });

  test("shutdown requested before the tick: nothing is claimed", async () => {
    const h = makeHarness({ batches: [[makeRow()]] });
    const dispatcher = createDispatcher(h.deps, CONFIG);
    dispatcher.requestShutdown();

    const stats = await dispatcher.tick();

    expect(h.deps.claimDueRecipients).not.toHaveBeenCalled();
    expect(h.deps.sendSms).not.toHaveBeenCalled();
    expect(stats.claimed).toBe(0);
  });
});
