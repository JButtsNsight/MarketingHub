/**
 * Round 2 Track B — Monday outcome write-back consumer.
 *
 * Runs INSIDE the SMS worker process (same bundle, same task) but fully
 * ISOLATED from the dispatcher in ./index.ts + ./dispatcher.ts, the same
 * doctrine as ./intel-consumer.ts:
 *
 * - its OWN `setInterval` (it never touches the dispatcher's sequential
 *   sleep/wake — that module-level wake assumes at most one pending sleep);
 * - a busy flag so a slow tick is skipped, never overlapped (with a periodic
 *   warning after repeated consecutive skips, so a wedged Monday call is
 *   observable instead of silently dead);
 * - EVERY code path inside try/catch — a consumer error is logged and the
 *   tick resolves; nothing can propagate into (or delay) SMS dispatch;
 * - MONDAY_API_TOKEN unset ⇒ warn-once quiet idle, re-checked every tick —
 *   the worker NEVER crashes over a missing write-back token.
 *
 * Tick (continuous idempotent sync — outcomes arrive late via delivery
 * reports, replies and opt-outs): pull up to `batch` candidate rows (board-
 * linked campaign + configured outcome column + monday_item_id + outcome-
 * bearing status, round-robin order — see lib/monday/writebackRepo), enrich
 * with reply/opt-out attribution, derive each row's outcome string, and:
 * outcome == synced snapshot ⇒ verified no-op (watermark bump only, no
 * Monday call); differs ⇒ one throttled/retried column write, then the
 * watermark records exactly what was written. A row whose write FAILS gets
 * its queue watermark bumped too (markAttemptFailed — snapshot untouched, so
 * it stays a candidate and retries once per full round-robin cycle): leaving
 * it in place would pin permanently-unwritable rows (deleted item, archived
 * board) at the head of the nulls-first/oldest-first order and wedge the
 * whole write-back once `batch` of them exist. A 401/403 additionally aborts
 * the rest of the tick — auth is global (a read-scoped token, runbook §15.2),
 * and burning the remaining batch against Monday's budget helps nobody. A
 * markSynced failure after a confirmed write re-writes the SAME value next
 * tick — Monday ends up byte-identical, so the retry is safe.
 */

import { isMondayConfigured } from "../lib/monday/client";
import {
  deriveOutcome,
  getRepliedRecipientIds,
  getSuppressionCreatedAt,
  listWritebackCandidates,
  markAttemptFailed,
  markSynced,
  markVerified,
  type WritebackCandidate,
} from "../lib/monday/writebackRepo";
import {
  createMondayWriter,
  type ColumnValueWrite,
  type MondayWriter,
} from "../lib/monday/writes";

/** Hard batch ceiling — a tick's Monday writes must stay boundable. */
const BATCH_MAX = 200;

export interface MondayWritebackConfig {
  /** MONDAY_WRITEBACK_ENABLED — ships ON; 'false'/'0'/'no'/'off' disables. */
  enabled: boolean;
  /** MONDAY_WRITEBACK_POLL_INTERVAL_MS — consumer's own interval. */
  pollMs: number;
  /** MONDAY_WRITEBACK_BATCH — candidate rows per tick (capped at 200). */
  batch: number;
  /** MONDAY_WRITEBACK_RATE_PER_SEC — writer throttle (1000/rate sleep). */
  ratePerSecond: number;
  /** MONDAY_WRITEBACK_MAX_ATTEMPTS — per-write 429/complexity retry budget. */
  maxAttempts: number;
}

export const MONDAY_WRITEBACK_DEFAULTS: MondayWritebackConfig = {
  enabled: true,
  pollMs: 60_000,
  batch: 25,
  ratePerSecond: 2,
  maxAttempts: 3,
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

/** Positive integer, else the default — batch/attempts are counts, not ms. */
function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Consumer config from env with documented defaults. */
export function buildMondayWritebackConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MondayWritebackConfig {
  const d = MONDAY_WRITEBACK_DEFAULTS;
  return {
    enabled: enabledFlag(env.MONDAY_WRITEBACK_ENABLED, d.enabled),
    pollMs: positiveNumber(env.MONDAY_WRITEBACK_POLL_INTERVAL_MS, d.pollMs),
    batch: Math.min(
      positiveInteger(env.MONDAY_WRITEBACK_BATCH, d.batch),
      BATCH_MAX,
    ),
    ratePerSecond: positiveNumber(
      env.MONDAY_WRITEBACK_RATE_PER_SEC,
      d.ratePerSecond,
    ),
    maxAttempts: positiveInteger(
      env.MONDAY_WRITEBACK_MAX_ATTEMPTS,
      d.maxAttempts,
    ),
  };
}

/** Injectable seams — production wiring in defaultDeps(). */
export interface MondayWritebackDeps {
  isConfigured(): boolean;
  listCandidates(limit: number): Promise<WritebackCandidate[]>;
  repliedRecipientIds(ids: string[]): Promise<Set<string>>;
  suppressionCreatedAt(
    phones: Array<string | null>,
  ): Promise<Map<string, string>>;
  /** One throttled/retried Monday column write (lib/monday/writes). */
  write(input: ColumnValueWrite): Promise<void>;
  markSynced(id: string, outcome: string, syncedAt: Date): Promise<void>;
  markVerified(ids: string[], verifiedAt: Date): Promise<void>;
  /** Failed-write queue bump — requeue-to-back, snapshot untouched. */
  markAttemptFailed(id: string, attemptedAt: Date): Promise<void>;
  log(record: Record<string, unknown>): void;
  now(): Date;
}

function defaultDeps(config: MondayWritebackConfig): MondayWritebackDeps {
  let writer: MondayWriter | null = null;
  const getWriter = () =>
    (writer ??= createMondayWriter({
      ratePerSecond: config.ratePerSecond,
      maxAttempts: config.maxAttempts,
    }));
  return {
    isConfigured: isMondayConfigured,
    listCandidates: listWritebackCandidates,
    repliedRecipientIds: getRepliedRecipientIds,
    suppressionCreatedAt: getSuppressionCreatedAt,
    write: (input) => getWriter().writeColumnValue(input),
    markSynced,
    markVerified,
    markAttemptFailed,
    log: (record) =>
      console.log(JSON.stringify({ at: new Date().toISOString(), ...record })),
    now: () => new Date(),
  };
}

/** Counters for one tick — mirrors the intel consumer's one-JSON-line habit. */
export interface WritebackTickStats {
  /** True when the tick was skipped because the previous one is running. */
  skipped: boolean;
  candidates: number;
  /** Monday writes confirmed + watermarked this tick. */
  written: number;
  /** Rows verified already in sync — watermark bumped, no Monday call. */
  unchanged: number;
  errors: string[];
}

function emptyStats(): WritebackTickStats {
  return { skipped: false, candidates: 0, written: 0, unchanged: 0, errors: [] };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A Monday 401/403 — a token-scope problem (or revoked token), global to the
 * whole batch, not one row's. Name-checked like the MondayConfigError branch
 * (test seams throw plain Errors).
 */
function isMondayAuthError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "MondayApiError") return false;
  const status = (err as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export interface MondayWritebackConsumer {
  /** One poll pass. Never rejects — every failure mode lands in stats/log. */
  tick(): Promise<WritebackTickStats>;
  /** Start the consumer's own interval (no-op when disabled or started). */
  start(): void;
  /** Clear the interval; in-flight work finishes on its own. */
  stop(): void;
}

export function createMondayWritebackConsumer(
  config: MondayWritebackConfig = MONDAY_WRITEBACK_DEFAULTS,
  overrides: Partial<MondayWritebackDeps> = {},
): MondayWritebackConsumer {
  const deps: MondayWritebackDeps = { ...defaultDeps(config), ...overrides };

  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  /**
   * Consecutive busy-skips. A hung Monday call keeps `busy` true forever;
   * warn every SKIP_WARN_EVERY skips so a wedge is observable, reset
   * whenever a tick actually runs. Same rationale as the intel consumer.
   */
  let consecutiveSkips = 0;
  const SKIP_WARN_EVERY = 10;
  let warnedUnconfigured = false;

  async function tick(): Promise<WritebackTickStats> {
    const stats = emptyStats();
    if (busy) {
      stats.skipped = true;
      consecutiveSkips += 1;
      if (consecutiveSkips % SKIP_WARN_EVERY === 0) {
        deps.log({
          msg:
            "monday-writeback: previous tick still running — consecutive " +
            "ticks skipped (likely a hung Monday/db call; write-back is " +
            "stalled until it settles or the task restarts; SMS dispatch " +
            "unaffected)",
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
      if (!deps.isConfigured()) {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true;
          deps.log({
            msg:
              "monday-writeback idle: MONDAY_API_TOKEN is not set — campaign " +
              "outcomes will not sync to Monday until it is configured (SMS " +
              "dispatch unaffected)",
            level: "warn",
          });
        }
        return stats;
      }
      warnedUnconfigured = false; // token present — warn again if it vanishes

      const candidates = await deps.listCandidates(config.batch);
      stats.candidates = candidates.length;
      if (candidates.length === 0) return stats;

      const replied = await deps.repliedRecipientIds(
        candidates.map((c) => c.id),
      );
      const suppressedAt = await deps.suppressionCreatedAt(
        candidates.map((c) => c.phoneE164),
      );

      const verifiedIds: string[] = [];
      for (const c of candidates) {
        const outcome = deriveOutcome({
          status: c.status,
          updatedAt: c.updatedAt,
          campaignSendAt: c.campaignSendAt,
          replied: replied.has(c.id),
          suppressedAt: c.phoneE164
            ? (suppressedAt.get(c.phoneE164) ?? null)
            : null,
        });

        // The idempotency contract: same outcome → same string → no write.
        if (outcome === c.mondaySyncedStatus) {
          verifiedIds.push(c.id);
          stats.unchanged += 1;
          continue;
        }

        try {
          await deps.write({
            boardId: c.boardId,
            itemId: c.mondayItemId,
            columnId: c.outcomeColumnId,
            value: outcome,
          });
          await deps.markSynced(c.id, outcome, deps.now());
          stats.written += 1;
        } catch (err) {
          // Per-row isolation: an unwritable row (bad column, deleted item)
          // must not block the rest of the batch.
          stats.errors.push(`recipient ${c.id}: ${messageOf(err)}`);
          if (err instanceof Error && err.name === "MondayConfigError") {
            // Token vanished mid-tick — nothing else in the batch can write.
            break;
          }
          // Queue bump on failure (requeue-to-back; snapshot untouched, so
          // the row stays a candidate and retries once per full cycle) —
          // without it, permanently-failing rows pin the round-robin head
          // and starve every other campaign once `batch` of them exist.
          try {
            await deps.markAttemptFailed(c.id, deps.now());
          } catch (bumpErr) {
            stats.errors.push(
              `recipient ${c.id}: attempt bump failed: ${messageOf(bumpErr)}`,
            );
          }
          if (isMondayAuthError(err)) {
            // 401/403 is global (wrong-scope/revoked token) — the rest of
            // the batch is doomed too; don't burn Monday budget proving it.
            deps.log({
              msg:
                "monday-writeback: Monday rejected the write (401/403) — " +
                "the token likely lacks WRITE scope (runbook §15.2); " +
                "remaining batch skipped this tick",
              level: "warn",
            });
            break;
          }
        }
      }

      if (verifiedIds.length > 0) {
        await deps.markVerified(verifiedIds, deps.now());
      }

      // Verified-only ticks stay silent — at rest the round-robin re-checks
      // rows forever, and a log line per poll would be noise, not signal.
      if (stats.written > 0 || stats.errors.length > 0) {
        deps.log({
          msg: "monday-writeback tick",
          candidates: stats.candidates,
          written: stats.written,
          unchanged: stats.unchanged,
          errors: stats.errors,
          ms: Date.now() - startedMs,
        });
      }
      return stats;
    } catch (err) {
      // Belt and suspenders: NOTHING escapes a tick. Unsynced rows keep
      // their old watermark and are simply re-derived next tick.
      stats.errors.push(messageOf(err));
      deps.log({
        msg:
          "monday-writeback tick failed — SMS dispatch unaffected; rows " +
          "re-check on the next tick",
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
        msg: "monday-writeback disabled via MONDAY_WRITEBACK_ENABLED — campaign outcomes will not sync to Monday",
        level: "warn",
      });
      return;
    }
    if (timer) return;
    deps.log({
      msg: "monday-writeback started",
      pollMs: config.pollMs,
      batch: config.batch,
      ratePerSecond: config.ratePerSecond,
      maxAttempts: config.maxAttempts,
    });
    timer = setInterval(() => {
      void tick();
    }, config.pollMs);
    void tick(); // first pass immediately — fresh outcomes sync without a wait
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    deps.log({ msg: "monday-writeback stopped" });
  }

  return { tick, start, stop };
}

/**
 * Env-driven convenience for the worker entry: builds config, starts the
 * consumer and registers its OWN SIGTERM/SIGINT stop handlers (never shared
 * with the dispatcher's). NEVER throws — any startup failure is logged and
 * the worker carries on dispatching SMS.
 */
export function startMondayWriteback(
  env: Record<string, string | undefined> = process.env,
): { stop(): void } {
  try {
    const consumer = createMondayWritebackConsumer(
      buildMondayWritebackConfigFromEnv(env),
    );
    consumer.start();
    const stop = () => consumer.stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return { stop };
  } catch (err) {
    console.error(
      "[monday-writeback] failed to start — SMS dispatch unaffected:",
      err,
    );
    return { stop() {} };
  }
}
