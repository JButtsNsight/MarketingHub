/**
 * Wave 8 — competitor-intel embedding queue consumer.
 *
 * Runs INSIDE the SMS worker process (same bundle, same task) but fully
 * ISOLATED from the dispatcher in ./index.ts + ./dispatcher.ts:
 *
 * - its OWN `setInterval` (it never touches the dispatcher's sequential
 *   sleep/wake — that module-level wake assumes at most one pending sleep);
 * - a busy flag so a slow tick is skipped, never overlapped (with a periodic
 *   warning after repeated consecutive skips, so a wedged/hung provider call
 *   is observable instead of silently dead);
 * - EVERY code path inside try/catch — a consumer error is logged and the
 *   tick resolves; nothing can propagate into (or delay) SMS dispatch;
 * - provider/backend failures degrade to "requeue later": the message is
 *   simply not archived, so pgmq redelivers it after the visibility timeout
 *   (no tight loop — the poll interval paces retries), and `read_ct` past
 *   CI_EMBED_MAX_ATTEMPTS dead-letters it (archive + document status 'error');
 * - missing substrate (pgmq_public not PostgREST-exposed yet, queue/schema
 *   not provisioned) ⇒ warn-once quiet idle, re-checked every tick.
 *
 * Tick (per W8 contract): read up to CI_EMBED_BATCH messages from the
 * 'ci_embed' queue via the service client's `.schema('pgmq_public').rpc()`
 * (W1 SECURITY DEFINER wrappers, service_role-only); for each message load
 * the document, chunk it, embed via the env-selected provider (stub by
 * default — zero AWS calls), delete-then-insert its chunk rows, mark the
 * document 'embedded' and archive the message (durable audit trail).
 * Duplicate deliveries for documents already 'embedded' are archived without
 * re-work (safe: a content edit resets status to 'pending' before its queue
 * message exists), and oversized rows (over the 500k-char content cap or the
 * 400-chunk cap — only reachable by writers that bypassed the route + DB
 * CHECK) are dead-lettered before chunking rather than risking this task's
 * memory.
 */

import { chunkText, type TextChunk } from "../lib/intel/chunker";
import {
  DOCUMENT_CONTENT_MAX_CHARS,
  DOCUMENT_MAX_CHUNKS,
  EMBEDDING_DIMS,
  INTEL_EMBED_QUEUE,
  INTEL_SCHEMA,
} from "../lib/intel/schema";
import { providerFromEnv, type EmbeddingProvider } from "../lib/intel/providers";
import { getServiceClient } from "../lib/supabase";

/** PostgREST-exposed schema holding the W1 pgmq SECURITY DEFINER wrappers. */
const PGMQ_SCHEMA = "pgmq_public";

export interface IntelConsumerConfig {
  /** CI_EMBED_ENABLED — ships ON; 'false'/'0'/'no'/'off' disables. */
  enabled: boolean;
  /** CI_EMBED_POLL_INTERVAL_MS — consumer's own interval, JS-only math. */
  pollMs: number;
  /** CI_EMBED_BATCH — messages per read (RPC int param). */
  batch: number;
  /** CI_EMBED_VT_S — visibility timeout = retry delay (RPC int param). */
  vtSeconds: number;
  /** CI_EMBED_MAX_ATTEMPTS — read_ct past this dead-letters the message. */
  maxAttempts: number;
  /** CI_EMBED_DIMS — must match the provider AND the vector(1024) column. */
  dims: number;
}

export const INTEL_CONSUMER_DEFAULTS: IntelConsumerConfig = {
  enabled: true,
  pollMs: 30_000,
  batch: 5,
  vtSeconds: 120,
  maxAttempts: 3,
  dims: EMBEDDING_DIMS,
};

/** Truthy unless explicitly disabled ('false'/'0'/'no'/'off', any case). */
function enabledFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

/** Positive finite number (fractional fine — JS-only math), else default. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Positive integer, else the default. Guards values that travel to the
 * pgmq_public RPC int params, where a fractional value ('2.5'::int) is a
 * 22P02 on every tick — the SMS claim-RPC restart-loop lesson.
 */
function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Consumer config from env with documented defaults. */
export function buildIntelConsumerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): IntelConsumerConfig {
  const d = INTEL_CONSUMER_DEFAULTS;
  return {
    enabled: enabledFlag(env.CI_EMBED_ENABLED, d.enabled),
    pollMs: positiveNumber(env.CI_EMBED_POLL_INTERVAL_MS, d.pollMs),
    batch: positiveInteger(env.CI_EMBED_BATCH, d.batch),
    vtSeconds: positiveInteger(env.CI_EMBED_VT_S, d.vtSeconds),
    maxAttempts: positiveInteger(env.CI_EMBED_MAX_ATTEMPTS, d.maxAttempts),
    dims: positiveInteger(env.CI_EMBED_DIMS, d.dims),
  };
}

// ---------------------------------------------------------------------------
// Minimal structural client surface — exactly the calls this module makes.
// The real SupabaseClient satisfies it at runtime (builders are thenables);
// tests inject a recording fake. The cast happens ONCE, in defaultDeps().
// ---------------------------------------------------------------------------

export interface IntelDbError {
  code?: string;
  message: string;
}

export interface IntelDbResult<T = unknown> {
  data: T | null;
  error: IntelDbError | null;
}

export interface IntelDbTable {
  select(columns: string): {
    eq(
      column: string,
      value: unknown,
    ): { maybeSingle(): PromiseLike<IntelDbResult> };
  };
  update(values: Record<string, unknown>): {
    eq(column: string, value: unknown): PromiseLike<IntelDbResult>;
  };
  delete(): {
    eq(column: string, value: unknown): PromiseLike<IntelDbResult>;
  };
  insert(rows: Record<string, unknown>[]): PromiseLike<IntelDbResult>;
}

export interface IntelDb {
  schema(name: string): {
    rpc(fn: string, args?: Record<string, unknown>): PromiseLike<IntelDbResult>;
    from(table: string): IntelDbTable;
  };
}

/** Injectable seams — production wiring in defaultDeps(). */
export interface IntelConsumerDeps {
  /** Service-role client (the queue wrappers are service_role-only). */
  db(): IntelDb;
  /** Env-selected embedding provider; throws EmbeddingConfigError if bad. */
  createProvider(): EmbeddingProvider;
  chunk(text: string): TextChunk[];
  log(record: Record<string, unknown>): void;
  now(): Date;
}

function defaultDeps(): IntelConsumerDeps {
  return {
    db: () => getServiceClient() as unknown as IntelDb,
    createProvider: () => providerFromEnv(),
    chunk: chunkText,
    log: (record) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), ...record })),
    now: () => new Date(),
  };
}

/** Counters for one tick — mirrors the dispatcher's one-JSON-line habit. */
export interface IntelTickStats {
  /** True when the tick was skipped because the previous one is running. */
  skipped: boolean;
  received: number;
  /** Documents fully embedded + archived this tick. */
  embedded: number;
  /** Chunk rows written this tick. */
  chunks: number;
  /** Messages left un-archived — pgmq redelivers after the VT expires. */
  requeued: number;
  /** Messages past maxAttempts — archived, document marked 'error'. */
  poisoned: number;
  /** Messages archived without work (document deleted / payload malformed). */
  discarded: number;
  errors: string[];
}

function emptyStats(): IntelTickStats {
  return {
    skipped: false,
    received: 0,
    embedded: 0,
    chunks: 0,
    requeued: 0,
    poisoned: 0,
    discarded: 0,
    errors: [],
  };
}

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  message: unknown;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * "Not provisioned yet" detection: pgmq_public not in PGRST_DB_SCHEMAS
 * (PGRST106), RPC missing from the schema cache (PGRST202), queue backing
 * table absent (42P01) or schema absent (3F000). These are expected until
 * the staged W8 migration + env change land — warn once, idle quietly.
 */
function isNotProvisioned(error: IntelDbError): boolean {
  const code = error.code ?? "";
  if (["PGRST106", "PGRST202", "42P01", "3F000"].includes(code)) return true;
  return /schema must be one of|does not exist|not found in the schema cache/i.test(
    error.message ?? "",
  );
}

export interface IntelConsumer {
  /** One poll pass. Never rejects — every failure mode lands in stats/log. */
  tick(): Promise<IntelTickStats>;
  /** Start the consumer's own interval (no-op when disabled or started). */
  start(): void;
  /** Clear the interval; in-flight work finishes on its own. */
  stop(): void;
}

export function createIntelConsumer(
  config: IntelConsumerConfig = INTEL_CONSUMER_DEFAULTS,
  overrides: Partial<IntelConsumerDeps> = {},
): IntelConsumer {
  const deps: IntelConsumerDeps = { ...defaultDeps(), ...overrides };

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  /**
   * Consecutive busy-skips. A hung provider call (network black hole) keeps
   * `busy` true forever; without this counter every subsequent tick would be
   * skipped SILENTLY and the pipeline would be dead with zero log evidence.
   * Warn every SKIP_WARN_EVERY skips (10 × 30s poll = every ~5 min) so a
   * wedge is observable; reset whenever a tick actually runs.
   */
  let consecutiveSkips = 0;
  const SKIP_WARN_EVERY = 10;
  let provider: EmbeddingProvider | null = null;
  /** Permanent for this process (env-derived) — warn once, then stay idle. */
  let providerBroken = false;
  let warnedNotProvisioned = false;

  const documents = (db: IntelDb) => db.schema(INTEL_SCHEMA).from("documents");
  const chunksTable = (db: IntelDb) => db.schema(INTEL_SCHEMA).from("chunks");

  function resolveProvider(): EmbeddingProvider | null {
    if (provider) return provider;
    if (providerBroken) return null;
    try {
      const candidate = deps.createProvider();
      if (candidate.dims !== config.dims) {
        throw new Error(
          `provider "${candidate.model}" emits ${candidate.dims}-dim vectors ` +
            `but the consumer is configured for ${config.dims} (CI_EMBED_DIMS)`,
        );
      }
      provider = candidate;
      return candidate;
    } catch (err) {
      providerBroken = true;
      deps.log({
        msg:
          "intel-consumer idle: embedding provider misconfigured — embedding " +
          "is paused until the env is fixed (SMS dispatch unaffected)",
        level: "error",
        error: messageOf(err),
      });
      return null;
    }
  }

  async function archiveMessage(db: IntelDb, msgId: number): Promise<void> {
    const res = await db.schema(PGMQ_SCHEMA).rpc("archive", {
      queue_name: INTEL_EMBED_QUEUE,
      message_id: msgId,
    });
    if (res.error) {
      throw new Error(`archive of msg ${msgId} failed: ${res.error.message}`);
    }
  }

  async function updateDocument(
    db: IntelDb,
    documentId: string,
    values: Record<string, unknown>,
    op: string,
  ): Promise<void> {
    const res = await documents(db)
      .update({ ...values, updated_at: deps.now().toISOString() })
      .eq("id", documentId);
    if (res.error) throw new Error(`${op} failed: ${res.error.message}`);
  }

  function extractDocumentId(message: unknown): string | null {
    if (typeof message !== "object" || message === null) return null;
    const id = (message as { document_id?: unknown }).document_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  function parseMessages(data: unknown, stats: IntelTickStats): QueueMessage[] {
    if (!Array.isArray(data)) return [];
    const out: QueueMessage[] = [];
    for (const item of data) {
      const row = item as {
        msg_id?: unknown;
        read_ct?: unknown;
        message?: unknown;
      };
      if (typeof row?.msg_id !== "number") {
        stats.errors.push("queue row without a numeric msg_id — ignored");
        continue;
      }
      out.push({
        msg_id: row.msg_id,
        read_ct: typeof row.read_ct === "number" ? row.read_ct : 1,
        message: row.message,
      });
    }
    return out;
  }

  /**
   * Dead-letter one document without an embed attempt: status 'error' with
   * an honest reason, message archived, counted as poisoned.
   */
  async function poisonDocument(
    db: IntelDb,
    documentId: string,
    msgId: number,
    reason: string,
    stats: IntelTickStats,
  ): Promise<void> {
    await updateDocument(
      db,
      documentId,
      { status: "error", error: reason },
      `mark doc ${documentId} error`,
    );
    await archiveMessage(db, msgId);
    stats.poisoned += 1;
    stats.errors.push(`doc ${documentId} (msg ${msgId}): ${reason}`);
  }

  /**
   * Load → skip-if-embedded → guard size → chunk → embed →
   * delete-then-insert chunks → mark embedded → archive. Any throw is caught
   * by the caller and counted as `requeued` (the message stays in the queue
   * and redelivers after the visibility timeout). Every step is idempotent,
   * so a redelivered message re-runs safely.
   */
  async function embedDocument(
    db: IntelDb,
    embedProvider: EmbeddingProvider,
    documentId: string,
    msgId: number,
    stats: IntelTickStats,
  ): Promise<void> {
    const got = await documents(db)
      .select("id,content,status")
      .eq("id", documentId)
      .maybeSingle();
    if (got.error) {
      throw new Error(`load doc ${documentId} failed: ${got.error.message}`);
    }
    if (!got.data) {
      // Document deleted since enqueue — nothing to embed, retire the message.
      await archiveMessage(db, msgId);
      stats.discarded += 1;
      return;
    }

    const row = got.data as { content?: unknown; status?: unknown };
    if (row.status === "embedded") {
      // Duplicate delivery for an already-embedded document (trigger dupes,
      // sweep re-enqueues that raced a slow first attempt): archive without
      // re-embedding. Safe because every content edit resets status to
      // 'pending' (BEFORE UPDATE trigger) before its queue message exists —
      // 'embedded' means the chunks already match this content. Without this
      // short-circuit, an accumulated duplicate backlog would re-run a full
      // chunk/embed/insert cycle (paid InvokeModel calls under Bedrock) per
      // message for identical output.
      await archiveMessage(db, msgId);
      stats.discarded += 1;
      return;
    }

    const content = row.content;
    if (
      typeof content === "string" &&
      content.length > DOCUMENT_CONTENT_MAX_CHARS
    ) {
      // Oversized row (only reachable by writers that bypass the API route's
      // zod cap and the DB CHECK, e.g. rows predating the constraint):
      // chunking + embedding it could OOM this shared worker task, and the
      // consumer's try/catch cannot fence an OOM — dead-letter it instead.
      await poisonDocument(
        db,
        documentId,
        msgId,
        `content is ${content.length} characters — over the ` +
          `${DOCUMENT_CONTENT_MAX_CHARS} cap; delete and re-add a smaller document`,
        stats,
      );
      return;
    }

    await updateDocument(
      db,
      documentId,
      { status: "processing" },
      `mark doc ${documentId} processing`,
    );

    const parts = typeof content === "string" ? deps.chunk(content) : [];
    if (parts.length > DOCUMENT_MAX_CHUNKS) {
      // Belt-and-suspenders with the content cap: never embed/insert an
      // unbounded chunk set in one pass on this 512 MiB task.
      await poisonDocument(
        db,
        documentId,
        msgId,
        `chunker produced ${parts.length} chunks — over the ` +
          `${DOCUMENT_MAX_CHUNKS} cap; delete and re-add a smaller document`,
        stats,
      );
      return;
    }

    const vectors =
      parts.length > 0
        ? await embedProvider.embed(parts.map((part) => part.content))
        : [];
    if (vectors.length !== parts.length) {
      throw new Error(
        `provider returned ${vectors.length} vectors for ${parts.length} chunks`,
      );
    }
    for (const vector of vectors) {
      if (vector.length !== config.dims) {
        throw new Error(
          `provider returned a ${vector.length}-dim vector (expected ${config.dims})`,
        );
      }
    }

    const del = await chunksTable(db).delete().eq("document_id", documentId);
    if (del.error) {
      throw new Error(
        `clear chunks for doc ${documentId} failed: ${del.error.message}`,
      );
    }

    if (parts.length > 0) {
      const embeddedAt = deps.now().toISOString();
      const ins = await chunksTable(db).insert(
        parts.map((part, i) => ({
          document_id: documentId,
          seq: part.seq,
          content: part.content,
          token_estimate: part.tokenEstimate,
          embedding: vectors[i],
          embedding_model: embedProvider.model,
          embedded_at: embeddedAt,
        })),
      );
      if (ins.error) {
        throw new Error(
          `insert chunks for doc ${documentId} failed: ${ins.error.message}`,
        );
      }
    }

    await updateDocument(
      db,
      documentId,
      { status: "embedded", error: null },
      `mark doc ${documentId} embedded`,
    );
    await archiveMessage(db, msgId);

    stats.embedded += 1;
    stats.chunks += parts.length;
  }

  async function processMessage(
    db: IntelDb,
    embedProvider: EmbeddingProvider,
    m: QueueMessage,
    stats: IntelTickStats,
  ): Promise<void> {
    const documentId = extractDocumentId(m.message);

    // Dead-letter: read_ct counts deliveries, so a message being seen with
    // read_ct > maxAttempts has already failed maxAttempts times.
    if (m.read_ct > config.maxAttempts) {
      try {
        if (documentId) {
          await updateDocument(
            db,
            documentId,
            {
              status: "error",
              // Remediation copy must name an action the app actually has:
              // there is no document-edit surface (documents expose only
              // GET/DELETE), so the truthful retry path is delete + re-add.
              error:
                `embedding failed after ${config.maxAttempts} attempts — ` +
                `queue msg ${m.msg_id} archived; delete and re-add the document to retry`,
            },
            `mark doc ${documentId} error`,
          );
        }
        await archiveMessage(db, m.msg_id);
        stats.poisoned += 1;
        stats.errors.push(
          `msg ${m.msg_id} exceeded ${config.maxAttempts} attempts — dead-lettered`,
        );
      } catch (err) {
        stats.requeued += 1;
        stats.errors.push(`dead-letter msg ${m.msg_id}: ${messageOf(err)}`);
      }
      return;
    }

    if (!documentId) {
      // Malformed payload can never succeed — archive it out of the queue.
      try {
        await archiveMessage(db, m.msg_id);
        stats.discarded += 1;
        stats.errors.push(`msg ${m.msg_id} had no document_id — archived`);
      } catch (err) {
        stats.requeued += 1;
        stats.errors.push(`discard msg ${m.msg_id}: ${messageOf(err)}`);
      }
      return;
    }

    try {
      await embedDocument(db, embedProvider, documentId, m.msg_id, stats);
    } catch (err) {
      // Requeue-later: NOT archived, so pgmq redelivers after the VT expires.
      stats.requeued += 1;
      stats.errors.push(`doc ${documentId} (msg ${m.msg_id}): ${messageOf(err)}`);
    }
  }

  async function tick(): Promise<IntelTickStats> {
    const stats = emptyStats();
    if (busy) {
      stats.skipped = true;
      consecutiveSkips += 1;
      if (consecutiveSkips % SKIP_WARN_EVERY === 0) {
        deps.log({
          msg:
            "intel-consumer: previous tick still running — consecutive ticks " +
            "skipped (likely a hung provider/db call; embedding is stalled " +
            "until it settles or the task restarts; SMS dispatch unaffected)",
          level: "warn",
          consecutiveSkips,
        });
      }
      return stats;
    }
    busy = true;
    consecutiveSkips = 0;
    const startedMs = Date.now();
    try {
      const embedProvider = resolveProvider();
      if (!embedProvider) return stats; // already warned once

      const db = deps.db();
      const read = await db.schema(PGMQ_SCHEMA).rpc("read", {
        queue_name: INTEL_EMBED_QUEUE,
        sleep_seconds: config.vtSeconds,
        n: config.batch,
      });
      if (read.error) {
        if (isNotProvisioned(read.error)) {
          if (!warnedNotProvisioned) {
            warnedNotProvisioned = true;
            deps.log({
              msg:
                "intel-consumer idle: embedding substrate not provisioned yet " +
                "(pgmq_public/ci_embed unreachable) — will keep checking quietly",
              level: "warn",
              error: read.error.message,
            });
          }
        } else {
          stats.errors.push(read.error.message);
          deps.log({
            msg: "intel-consumer queue read failed — will retry next tick",
            level: "error",
            error: read.error.message,
          });
        }
        return stats;
      }
      warnedNotProvisioned = false; // substrate reachable — warn again if lost

      const messages = parseMessages(read.data, stats);
      stats.received = messages.length;
      if (messages.length === 0 && stats.errors.length === 0) return stats;

      for (const m of messages) {
        await processMessage(db, embedProvider, m, stats);
      }

      deps.log({
        msg: "intel-consumer tick",
        received: stats.received,
        embedded: stats.embedded,
        chunks: stats.chunks,
        requeued: stats.requeued,
        poisoned: stats.poisoned,
        discarded: stats.discarded,
        errors: stats.errors,
        ms: Date.now() - startedMs,
      });
      return stats;
    } catch (err) {
      // Belt and suspenders: NOTHING escapes a tick. Un-archived messages
      // redeliver after the VT; the poll interval paces the retry.
      stats.errors.push(messageOf(err));
      deps.log({
        msg:
          "intel-consumer tick failed — SMS dispatch unaffected; queued " +
          "messages redeliver after the visibility timeout",
        level: "error",
        error: messageOf(err),
      });
      return stats;
    } finally {
      busy = false;
    }
  }

  function start(): void {
    if (!config.enabled) {
      deps.log({
        msg: "intel-consumer disabled via CI_EMBED_ENABLED — embedding queue will not be drained",
        level: "warn",
      });
      return;
    }
    if (timer) return;
    deps.log({
      msg: "intel-consumer started",
      queue: INTEL_EMBED_QUEUE,
      pollMs: config.pollMs,
      batch: config.batch,
      vtSeconds: config.vtSeconds,
      maxAttempts: config.maxAttempts,
      dims: config.dims,
    });
    timer = setInterval(() => {
      void tick();
    }, config.pollMs);
    void tick(); // first pass immediately — new documents embed without a wait
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    deps.log({ msg: "intel-consumer stopped" });
  }

  return { tick, start, stop };
}

/**
 * Env-driven convenience for the worker entry: builds config, starts the
 * consumer and registers its OWN SIGTERM/SIGINT stop handlers (never shared
 * with the dispatcher's). NEVER throws — any startup failure is logged and
 * the worker carries on dispatching SMS.
 */
export function startIntelConsumer(
  env: Record<string, string | undefined> = process.env,
): { stop(): void } {
  try {
    const consumer = createIntelConsumer(buildIntelConsumerConfigFromEnv(env));
    consumer.start();
    const stop = () => consumer.stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return { stop };
  } catch (err) {
    console.error(
      "[intel-consumer] failed to start — SMS dispatch unaffected:",
      err,
    );
    return { stop() {} };
  }
}
