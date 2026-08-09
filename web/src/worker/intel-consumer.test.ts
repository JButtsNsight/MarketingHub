// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";

import type { EmbeddingProvider } from "../lib/intel/providers";
import {
  buildIntelConsumerConfigFromEnv,
  createIntelConsumer,
  INTEL_CONSUMER_DEFAULTS,
  type IntelConsumerConfig,
  type IntelDb,
  type IntelDbResult,
} from "./intel-consumer";

/**
 * Deterministic consumer tests: the db is a recording fake whose per-
 * operation result queues are scripted, the provider is a controllable fake,
 * and the clock is frozen. The core contract under test is ISOLATION — a
 * tick must resolve (never reject) no matter what the queue, the documents
 * tables or the provider do — plus the success/requeue/poison flows.
 */

const NOW = new Date("2026-08-08T12:00:00.000Z");
const DOC = "11111111-2222-3333-4444-555555555555";
const DIMS = 8;

const CONFIG: IntelConsumerConfig = {
  enabled: true,
  pollMs: 30_000,
  batch: 5,
  vtSeconds: 120,
  maxAttempts: 3,
  dims: DIMS,
};

interface FakeCall {
  schema: string;
  op: string; // 'rpc:<fn>' | '<table>.select|update|delete|insert'
  args?: unknown;
  values?: unknown;
  eq?: [string, unknown];
}

type Scripted = IntelDbResult | (() => Promise<IntelDbResult>);

const ok = (data: unknown = null): IntelDbResult => ({ data, error: null });
const err = (message: string, code?: string): IntelDbResult => ({
  data: null,
  error: { message, code },
});

/**
 * Recording fake of the minimal IntelDb surface. Each operation consumes the
 * next scripted result for its key ('rpc:read', 'documents.update', ...);
 * unscripted operations resolve `{ data: null, error: null }`.
 */
function fakeDb(script: Partial<Record<string, Scripted[]>> = {}) {
  const calls: FakeCall[] = [];
  const next = (key: string): Promise<IntelDbResult> => {
    const queue = script[key];
    if (queue && queue.length > 0) {
      const item = queue.shift() as Scripted;
      return typeof item === "function" ? item() : Promise.resolve(item);
    }
    return Promise.resolve(ok());
  };
  const db: IntelDb = {
    schema(schemaName: string) {
      return {
        rpc(fn: string, args?: Record<string, unknown>) {
          calls.push({ schema: schemaName, op: `rpc:${fn}`, args });
          return next(`rpc:${fn}`);
        },
        from(table: string) {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: unknown) {
                  return {
                    maybeSingle() {
                      calls.push({
                        schema: schemaName,
                        op: `${table}.select`,
                        values: columns,
                        eq: [column, value],
                      });
                      return next(`${table}.select`);
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: unknown) {
                  calls.push({
                    schema: schemaName,
                    op: `${table}.update`,
                    values,
                    eq: [column, value],
                  });
                  return next(`${table}.update`);
                },
              };
            },
            delete() {
              return {
                eq(column: string, value: unknown) {
                  calls.push({
                    schema: schemaName,
                    op: `${table}.delete`,
                    eq: [column, value],
                  });
                  return next(`${table}.delete`);
                },
              };
            },
            insert(rows: Record<string, unknown>[]) {
              calls.push({ schema: schemaName, op: `${table}.insert`, values: rows });
              return next(`${table}.insert`);
            },
          };
        },
      };
    },
  };
  return { db, calls };
}

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    dims: DIMS,
    model: "stub-test",
    embed: async (texts: string[]) =>
      texts.map(() => new Array<number>(DIMS).fill(0.5)),
    ...overrides,
  };
}

function queueMsg(msgId: number, readCt = 1, message: unknown = { document_id: DOC }) {
  return {
    msg_id: msgId,
    read_ct: readCt,
    enqueued_at: NOW.toISOString(),
    vt: NOW.toISOString(),
    message,
  };
}

function makeConsumer(
  db: IntelDb,
  extra: {
    provider?: EmbeddingProvider;
    createProvider?: () => EmbeddingProvider;
    config?: Partial<IntelConsumerConfig>;
    dbFactory?: () => IntelDb;
    chunk?: (text: string) => Array<{ seq: number; content: string; tokenEstimate: number }>;
  } = {},
) {
  const log = vi.fn();
  const consumer = createIntelConsumer(
    { ...CONFIG, ...extra.config },
    {
      db: extra.dbFactory ?? (() => db),
      createProvider: extra.createProvider ?? (() => extra.provider ?? fakeProvider()),
      ...(extra.chunk ? { chunk: extra.chunk } : {}),
      log,
      now: () => NOW,
    },
  );
  return { consumer, log };
}

const ops = (calls: FakeCall[]) => calls.map((c) => c.op);

afterEach(() => {
  vi.useRealTimers();
});

describe("buildIntelConsumerConfigFromEnv", () => {
  test("returns the documented defaults when nothing is set", () => {
    expect(buildIntelConsumerConfigFromEnv({})).toEqual({
      enabled: true,
      pollMs: 30_000,
      batch: 5,
      vtSeconds: 120,
      maxAttempts: 3,
      dims: 1024,
    });
    expect(INTEL_CONSUMER_DEFAULTS.dims).toBe(1024);
  });

  test("honors env overrides", () => {
    expect(
      buildIntelConsumerConfigFromEnv({
        CI_EMBED_ENABLED: "false",
        CI_EMBED_POLL_INTERVAL_MS: "5000",
        CI_EMBED_BATCH: "2",
        CI_EMBED_VT_S: "60",
        CI_EMBED_MAX_ATTEMPTS: "5",
        CI_EMBED_DIMS: "512",
      }),
    ).toEqual({
      enabled: false,
      pollMs: 5000,
      batch: 2,
      vtSeconds: 60,
      maxAttempts: 5,
      dims: 512,
    });
  });

  test("CI_EMBED_ENABLED: only explicit false-y tokens disable", () => {
    for (const raw of ["false", "FALSE", "0", "no", "off", " Off "]) {
      expect(buildIntelConsumerConfigFromEnv({ CI_EMBED_ENABLED: raw }).enabled).toBe(
        false,
      );
    }
    for (const raw of [undefined, "", "true", "1", "yes", "banana"]) {
      expect(buildIntelConsumerConfigFromEnv({ CI_EMBED_ENABLED: raw }).enabled).toBe(
        true,
      );
    }
  });

  test("fractional RPC-bound ints fall back ('2.5'::int is a 22P02 crash-tick); fractional pollMs passes (JS-only)", () => {
    expect(
      buildIntelConsumerConfigFromEnv({
        CI_EMBED_BATCH: "2.5",
        CI_EMBED_VT_S: "60.5",
        CI_EMBED_MAX_ATTEMPTS: "1.5",
        CI_EMBED_DIMS: "0",
        CI_EMBED_POLL_INTERVAL_MS: "250.5",
      }),
    ).toEqual({
      enabled: true,
      pollMs: 250.5,
      batch: 5,
      vtSeconds: 120,
      maxAttempts: 3,
      dims: 1024,
    });
  });

  test("non-numeric / non-positive values fall back to the defaults", () => {
    expect(
      buildIntelConsumerConfigFromEnv({
        CI_EMBED_POLL_INTERVAL_MS: "soon",
        CI_EMBED_BATCH: "-1",
        CI_EMBED_VT_S: "",
        CI_EMBED_MAX_ATTEMPTS: "lots",
        CI_EMBED_DIMS: "-8",
      }),
    ).toEqual(INTEL_CONSUMER_DEFAULTS);
  });
});

describe("tick — success path", () => {
  test("reads the queue, embeds, delete-then-inserts chunks, marks embedded, archives", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(101)])],
      "documents.select": [ok({ id: DOC, content: "Alpha beta gamma." })],
    });
    const provider = fakeProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    const { consumer, log } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    expect(ops(calls)).toEqual([
      "rpc:read",
      "documents.select", // load first: duplicate/oversized short-circuits
      "documents.update", // → processing
      "chunks.delete",
      "chunks.insert",
      "documents.update", // → embedded
      "rpc:archive",
    ]);

    // Queue ops go through pgmq_public with the exact wrapper arg names.
    expect(calls[0].schema).toBe("pgmq_public");
    expect(calls[0].args).toEqual({
      queue_name: "ci_embed",
      sleep_seconds: 120,
      n: 5,
    });
    expect(calls[6].schema).toBe("pgmq_public");
    expect(calls[6].args).toEqual({ queue_name: "ci_embed", message_id: 101 });

    // Table ops go through the competitor_intel schema.
    expect(calls[1].schema).toBe("competitor_intel");
    expect(calls[2].values).toEqual({
      status: "processing",
      updated_at: NOW.toISOString(),
    });
    expect(calls[2].eq).toEqual(["id", DOC]);

    expect(calls[3].eq).toEqual(["document_id", DOC]);
    const rows = calls[4].values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document_id: DOC,
      seq: 0,
      content: "Alpha beta gamma.",
      embedding_model: "stub-test",
      embedded_at: NOW.toISOString(),
    });
    expect(rows[0].embedding).toHaveLength(DIMS);
    expect(rows[0].token_estimate).toBeGreaterThan(0);

    expect(calls[5].values).toEqual({
      status: "embedded",
      error: null,
      updated_at: NOW.toISOString(),
    });

    expect(embedSpy).toHaveBeenCalledWith(["Alpha beta gamma."]);
    expect(stats).toMatchObject({
      skipped: false,
      received: 1,
      embedded: 1,
      chunks: 1,
      requeued: 0,
      poisoned: 0,
      discarded: 0,
      errors: [],
    });

    // Exactly one JSON log line for the non-empty tick.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "intel-consumer tick", received: 1, embedded: 1 }),
    );
  });

  test("an empty queue tick is silent (no log line)", async () => {
    const { db } = fakeDb({ "rpc:read": [ok([])] });
    const { consumer, log } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(stats.received).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("tick — provider failure degrades to requeue-later", () => {
  test("embed rejection leaves the message un-archived and writes no chunks", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(102)])],
      "documents.select": [ok({ id: DOC, content: "Alpha beta gamma." })],
    });
    const provider = fakeProvider({
      embed: async () => {
        throw new Error("bedrock unavailable");
      },
    });
    const { consumer, log } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    // No archive, no chunk delete/insert, no embedded/error status write —
    // the message redelivers after the VT (paced by the poll interval).
    expect(ops(calls)).toEqual(["rpc:read", "documents.select", "documents.update"]);
    expect(stats).toMatchObject({ received: 1, embedded: 0, requeued: 1 });
    expect(stats.errors[0]).toContain("bedrock unavailable");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "intel-consumer tick", requeued: 1 }),
    );
  });

  test("wrong-width provider vectors are rejected before any chunk write", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(103)])],
      "documents.select": [ok({ id: DOC, content: "Alpha beta gamma." })],
    });
    const provider = fakeProvider({
      embed: async (texts) => texts.map(() => [0.5, 0.5]), // 2 ≠ 8 dims
    });
    const { consumer } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    expect(ops(calls)).not.toContain("chunks.insert");
    expect(ops(calls)).not.toContain("rpc:archive");
    expect(stats.requeued).toBe(1);
    expect(stats.errors[0]).toContain("2-dim");
  });
});

describe("tick — poison cap", () => {
  test("read_ct past maxAttempts dead-letters: doc status 'error' + archive, provider never called", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(104, CONFIG.maxAttempts + 1)])],
    });
    const provider = fakeProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    const { consumer } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    expect(ops(calls)).toEqual(["rpc:read", "documents.update", "rpc:archive"]);
    expect(calls[1].values).toMatchObject({ status: "error" });
    expect(String((calls[1].values as Record<string, unknown>).error)).toContain(
      "after 3 attempts",
    );
    // Remediation copy must name an action the app supports: there is no
    // document-edit surface, so the truthful retry path is delete + re-add.
    expect(String((calls[1].values as Record<string, unknown>).error)).toContain(
      "delete and re-add the document",
    );
    expect(calls[2].args).toEqual({ queue_name: "ci_embed", message_id: 104 });
    expect(embedSpy).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ poisoned: 1, embedded: 0, requeued: 0 });
  });

  test("read_ct at exactly maxAttempts still gets a real attempt", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(105, CONFIG.maxAttempts)])],
      "documents.select": [ok({ id: DOC, content: "Alpha." })],
    });
    const { consumer } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(ops(calls)).toContain("chunks.insert");
    expect(stats.embedded).toBe(1);
  });
});

describe("tick — duplicate suppression and size guards", () => {
  test("a duplicate message for an already-embedded doc archives without re-embedding", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(120)])],
      "documents.select": [
        ok({ id: DOC, content: "Alpha beta gamma.", status: "embedded" }),
      ],
    });
    const provider = fakeProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    const { consumer } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    // No chunk churn, no status writes, no provider call — just retire the
    // duplicate (sweep re-enqueues / trigger dupes cost zero embed work).
    expect(ops(calls)).toEqual(["rpc:read", "documents.select", "rpc:archive"]);
    expect(embedSpy).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ discarded: 1, embedded: 0, requeued: 0 });
  });

  test("content over the 500k-char cap dead-letters before chunking (provider never called)", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(121)])],
      "documents.select": [
        ok({ id: DOC, content: "x".repeat(500_001), status: "pending" }),
      ],
    });
    const provider = fakeProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    const { consumer } = makeConsumer(db, { provider });

    const stats = await consumer.tick();

    expect(ops(calls)).toEqual(["rpc:read", "documents.select", "documents.update", "rpc:archive"]);
    expect(calls[2].values).toMatchObject({ status: "error" });
    expect(String((calls[2].values as Record<string, unknown>).error)).toContain(
      "over the 500000 cap",
    );
    expect(embedSpy).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ poisoned: 1, embedded: 0, requeued: 0 });
  });

  test("a pathological chunk count dead-letters instead of a giant embed/insert pass", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(122)])],
      "documents.select": [
        ok({ id: DOC, content: "Alpha beta gamma.", status: "pending" }),
      ],
    });
    const provider = fakeProvider();
    const embedSpy = vi.spyOn(provider, "embed");
    const { consumer } = makeConsumer(db, {
      provider,
      chunk: () =>
        Array.from({ length: 401 }, (_, seq) => ({
          seq,
          content: "c",
          tokenEstimate: 1,
        })),
    });

    const stats = await consumer.tick();

    expect(ops(calls)).toEqual([
      "rpc:read",
      "documents.select",
      "documents.update", // → processing
      "documents.update", // → error (dead-letter)
      "rpc:archive",
    ]);
    expect(calls[3].values).toMatchObject({ status: "error" });
    expect(String((calls[3].values as Record<string, unknown>).error)).toContain(
      "401 chunks",
    );
    expect(embedSpy).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ poisoned: 1, embedded: 0 });
  });
});

describe("tick — stale and malformed messages", () => {
  test("document deleted since enqueue → message archived, nothing written", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(106)])],
      "documents.select": [ok(null)],
    });
    const { consumer } = makeConsumer(db);

    const stats = await consumer.tick();

    // No status write at all — the doc is gone; the message just retires.
    expect(ops(calls)).toEqual(["rpc:read", "documents.select", "rpc:archive"]);
    expect(stats).toMatchObject({ discarded: 1, embedded: 0, requeued: 0 });
  });

  test("payload without document_id → archived out of the queue", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(107, 1, { nope: true })])],
    });
    const { consumer } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(ops(calls)).toEqual(["rpc:read", "rpc:archive"]);
    expect(stats.discarded).toBe(1);
  });
});

describe("tick — isolation (a consumer error NEVER propagates)", () => {
  test("queue read rejecting (thrown, not {error}) resolves the tick", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [() => Promise.reject(new Error("socket hang up"))],
    });
    const { consumer, log } = makeConsumer(db);

    await expect(consumer.tick()).resolves.toMatchObject({
      received: 0,
      errors: ["socket hang up"],
    });
    expect(ops(calls)).toEqual(["rpc:read"]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", error: "socket hang up" }),
    );
  });

  test("db factory throwing synchronously resolves the tick", async () => {
    const { consumer, log } = makeConsumer(fakeDb().db, {
      dbFactory: () => {
        throw new Error("no client");
      },
    });

    await expect(consumer.tick()).resolves.toMatchObject({
      errors: ["no client"],
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", error: "no client" }),
    );
  });

  test("a failure on one message does not stop the rest of the batch", async () => {
    const OTHER_DOC = "99999999-8888-7777-6666-555555555555";
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(108), queueMsg(109, 1, { document_id: OTHER_DOC })])],
      "documents.select": [
        () => Promise.reject(new Error("row fetch blew up")),
        ok({ id: OTHER_DOC, content: "Second doc." }),
      ],
    });
    const { consumer } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(stats).toMatchObject({ received: 2, requeued: 1, embedded: 1 });
    expect(calls.filter((c) => c.op === "rpc:archive")).toHaveLength(1);
  });

  test("archive failure after a successful embed counts as requeued (redelivery re-runs idempotently)", async () => {
    const { db, calls } = fakeDb({
      "rpc:read": [ok([queueMsg(110)])],
      "documents.select": [ok({ id: DOC, content: "Alpha." })],
      "rpc:archive": [err("archive exploded")],
    });
    const { consumer } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(ops(calls)).toContain("chunks.insert");
    expect(stats).toMatchObject({ embedded: 0, requeued: 1 });
    expect(stats.errors[0]).toContain("archive exploded");
  });
});

describe("tick — substrate not provisioned yet (warn-once idle)", () => {
  test("PGRST106 warns exactly once across ticks and re-arms after a success", async () => {
    const notExposed = err(
      'The schema must be one of the following: public, storage, graphql_public, marketinghub',
      "PGRST106",
    );
    const { db } = fakeDb({
      "rpc:read": [notExposed, notExposed, ok([]), notExposed],
    });
    const { consumer, log } = makeConsumer(db);

    await consumer.tick();
    await consumer.tick();
    const warns = () =>
      log.mock.calls.filter(([record]) =>
        String((record as Record<string, unknown>).msg).includes("not provisioned"),
      );
    expect(warns()).toHaveLength(1);

    await consumer.tick(); // substrate reachable — resets the warn-once latch
    await consumer.tick(); // lost again → warns again
    expect(warns()).toHaveLength(2);
  });

  test("a missing queue (42P01) idles quietly too, and never counts as an error tick", async () => {
    const { db } = fakeDb({
      "rpc:read": [err('relation "pgmq.q_ci_embed" does not exist', "42P01")],
    });
    const { consumer, log } = makeConsumer(db);

    const stats = await consumer.tick();

    expect(stats.errors).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }));
  });
});

describe("tick — busy flag (no overlapping ticks)", () => {
  test("a second tick during a slow first tick is skipped without touching the queue", async () => {
    let release: () => void = () => {};
    const { db, calls } = fakeDb({
      "rpc:read": [
        () =>
          new Promise<IntelDbResult>((resolve) => {
            release = () => resolve(ok([]));
          }),
      ],
    });
    const { consumer } = makeConsumer(db);

    const first = consumer.tick();
    const second = await consumer.tick();

    expect(second.skipped).toBe(true);
    expect(calls.filter((c) => c.op === "rpc:read")).toHaveLength(1);

    release?.();
    await expect(first).resolves.toMatchObject({ skipped: false });
  });

  test("repeated consecutive skips warn periodically (a wedged tick is observable)", async () => {
    // A read that never settles = a hung provider/db call wedging `busy`.
    const { db } = fakeDb({
      "rpc:read": [() => new Promise<IntelDbResult>(() => {})],
    });
    const { consumer, log } = makeConsumer(db);

    void consumer.tick(); // wedges forever
    for (let i = 0; i < 10; i++) await consumer.tick();

    const warns = log.mock.calls.filter(([record]) =>
      String((record as Record<string, unknown>).msg).includes(
        "previous tick still running",
      ),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ level: "warn", consecutiveSkips: 10 });

    // Nine more skips: the next warning fires at 20, not before.
    for (let i = 0; i < 9; i++) await consumer.tick();
    expect(
      log.mock.calls.filter(([record]) =>
        String((record as Record<string, unknown>).msg).includes(
          "previous tick still running",
        ),
      ),
    ).toHaveLength(1);
  });
});

describe("provider misconfiguration (warn-once, permanent idle)", () => {
  test("createProvider throwing pauses the consumer without touching the queue", async () => {
    const { db, calls } = fakeDb();
    const { consumer, log } = makeConsumer(db, {
      createProvider: () => {
        throw new Error('CI_EMBED_PROVIDER must be one of: stub, bedrock (got "x")');
      },
    });

    await consumer.tick();
    await consumer.tick();

    expect(calls).toHaveLength(0);
    const warns = log.mock.calls.filter(([record]) =>
      String((record as Record<string, unknown>).msg).includes("misconfigured"),
    );
    expect(warns).toHaveLength(1);
  });

  test("provider dims disagreeing with CI_EMBED_DIMS pauses the consumer", async () => {
    const { db, calls } = fakeDb();
    const { consumer, log } = makeConsumer(db, {
      provider: fakeProvider({ dims: 4 }),
    });

    const stats = await consumer.tick();

    expect(calls).toHaveLength(0);
    expect(stats.embedded).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        error: expect.stringContaining("4-dim"),
      }),
    );
  });
});

describe("start/stop — the consumer's own interval", () => {
  test("start ticks immediately, then on its own interval; stop halts it", async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb();
    const { consumer } = makeConsumer(db);
    const reads = () => calls.filter((c) => c.op === "rpc:read").length;

    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1); // immediate first pass

    await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    expect(reads()).toBe(2);

    consumer.stop();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs * 3);
    expect(reads()).toBe(2);
  });

  test("start is idempotent (a second start never doubles the interval)", async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb();
    const { consumer } = makeConsumer(db);

    consumer.start();
    consumer.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs);
    expect(calls.filter((c) => c.op === "rpc:read").length).toBe(2);
  });

  test("CI_EMBED_ENABLED=false: start logs the disabled warning and never polls", async () => {
    vi.useFakeTimers();
    const { db, calls } = fakeDb();
    const { consumer, log } = makeConsumer(db, { config: { enabled: false } });

    consumer.start();
    await vi.advanceTimersByTimeAsync(CONFIG.pollMs * 2);

    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        msg: expect.stringContaining("disabled"),
      }),
    );
  });
});
