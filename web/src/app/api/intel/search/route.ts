import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import { NotProvisionedError, searchChunksFts } from "@/lib/intel/repo";
import {
  SearchInputSchema,
  type FtsChunkRow,
  type SearchResponse,
  type SynthesisResult,
} from "@/lib/intel/schema";
import {
  GatewayError,
  gatewayFromEnv,
  submitSynthesis,
} from "@/lib/intel/gateway";

/**
 * Wave-8R agentic search over competitor-intel chunks (2026-08-10).
 *
 * Phase 1 (this route): Postgres full-text search (`search_chunks_fts` RPC,
 * SECURITY INVOKER — RLS applies to the user client) returns ranked keyword
 * candidates immediately; when the headless-claude gateway is configured, an
 * answer-synthesis task is also enqueued and surfaced as
 * `answer: {state:"pending", taskId}`. Phase 2: the browser polls
 * /api/intel/search/answer/[taskId] until completed/failed or its deadline.
 *
 * Honest degradation: no gateway env → `mode:"keyword-only"` + `degraded`
 * marker; gateway submit failure → keyword results still return 200. The
 * dormant pgvector path (`searchChunks`/match_chunks + embedding providers)
 * is deliberately no longer called here — it stays intact for the worker and
 * the parity demonstration.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Identical queries reuse the in-flight synthesis task for 5 minutes. */
const IN_FLIGHT_TTL_MS = 5 * 60_000;

/** In-flight map bound (the completed cache has its own 50-entry bound in the
 * answer route) — a burst of unique queries must not grow the map without
 * limit; oldest entries are evicted first. */
const IN_FLIGHT_MAX_ENTRIES = 200;

/**
 * Per-process budget on gateway task submissions: burst of 10, then one
 * every 2 s (≤30/min sustained). A runaway tab or scripted user varying a
 * keyword must not be able to spend unbounded opus tasks or starve the
 * ACCOUNT-WIDE 10 rps gateway throttle shared with other ClaudeCloud
 * clients. Exhaustion degrades honestly to keyword-only
 * (`synthesis-unavailable`) — results still return.
 */
const SUBMIT_BURST = 10;
const SUBMIT_REFILL_MS = 2_000;

// ---------------------------------------------------------------------------
// Module-level answer store, shared with the answer route via a `Symbol.for`
// slot on globalThis (Next.js rejects non-handler exports from route modules,
// so the two routes cannot share state through imports). Process-local and
// best-effort: a cold miss only costs one extra gateway task.
//   completed: `q|sourceId|count|chunkIds` → SynthesisResult (10-min TTL,
//              ≤50 entries; WRITTEN by the answer route when a poll completes)
//   inFlight:  `q|sourceId|count|chunkIds` → taskId (5-min TTL; written here)
// The key embeds a fingerprint of the ORDERED candidate chunk ids: citations
// and ranking are positional into the list the model actually read, so a
// cached/pending answer may only ever be served against an identical fresh
// retrieval — corpus drift busts the key and forces a resubmit (spec §11).
// The accessor/prune helpers are mirrored verbatim in answer/[taskId]/route.ts.
// ---------------------------------------------------------------------------

interface CompletedEntry {
  result: SynthesisResult;
  expiresAt: number;
}

interface InFlightEntry {
  taskId: string;
  expiresAt: number;
}

interface SubmitBucket {
  tokens: number;
  lastRefillAt: number;
}

interface AnswerStore {
  completed: Map<string, CompletedEntry>;
  inFlight: Map<string, InFlightEntry>;
  /** Submission budget — used only by this route; lazily initialized. */
  submitBucket?: SubmitBucket;
}

const STORE_KEY = Symbol.for("marketinghub.intel.search-answer-store");

function answerStore(): AnswerStore {
  const g = globalThis as unknown as Record<symbol, AnswerStore | undefined>;
  let store = g[STORE_KEY];
  if (!store) {
    store = { completed: new Map(), inFlight: new Map() };
    g[STORE_KEY] = store;
  }
  return store;
}

/** Lazy expiry: both maps are pruned on every cache interaction. */
function pruneExpired(store: AnswerStore, now: number): void {
  for (const [key, entry] of store.completed) {
    if (entry.expiresAt <= now) store.completed.delete(key);
  }
  for (const [key, entry] of store.inFlight) {
    if (entry.expiresAt <= now) store.inFlight.delete(key);
  }
}

/** Record an in-flight submission under the bounded map (oldest evicted). */
function putInFlight(
  store: AnswerStore,
  key: string,
  taskId: string,
  now: number,
): void {
  store.inFlight.delete(key); // re-put refreshes insertion order
  while (store.inFlight.size >= IN_FLIGHT_MAX_ENTRIES) {
    const oldest = store.inFlight.keys().next().value;
    if (oldest === undefined) break;
    store.inFlight.delete(oldest);
  }
  store.inFlight.set(key, { taskId, expiresAt: now + IN_FLIGHT_TTL_MS });
}

/** Take one submission token; false = budget exhausted (degrade, no submit). */
function takeSubmitToken(store: AnswerStore, now: number): boolean {
  let bucket = store.submitBucket;
  if (!bucket) {
    bucket = { tokens: SUBMIT_BURST, lastRefillAt: now };
    store.submitBucket = bucket;
  }
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed > 0) {
    bucket.tokens = Math.min(
      SUBMIT_BURST,
      bucket.tokens + elapsed / SUBMIT_REFILL_MS,
    );
    bucket.lastRefillAt = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ---------------------------------------------------------------------------

/** Generic by design: degraded details must never leak gateway internals. */
const SYNTHESIS_UNAVAILABLE_DETAIL =
  "Answer synthesis is temporarily unavailable — results are keyword-ranked only.";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

function respond(body: SearchResponse): Response {
  return Response.json(body);
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const countRaw = url.searchParams.get("count");
  const sourceIdRaw = url.searchParams.get("sourceId");
  const parsed = SearchInputSchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    // Absent/blank params fall back to schema defaults (null / 16).
    sourceId: sourceIdRaw ? sourceIdRaw : null,
    count: countRaw ? countRaw : undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { q, sourceId, count } = parsed.data;

  const db = await getUserClient(user);
  let results: FtsChunkRow[];
  try {
    results = await searchChunksFts(q, { sourceId, count }, db);
  } catch (err) {
    if (err instanceof NotProvisionedError) {
      return Response.json(
        { error: "intel-not-provisioned", message: err.message },
        { status: 503 },
      );
    }
    throw err;
  }

  const cfg = gatewayFromEnv();

  // Zero candidates → nothing to cite, nothing to synthesize; never spend a
  // gateway task (cost bound).
  if (results.length === 0) {
    return respond({
      query: q,
      mode: cfg ? "agentic" : "keyword-only",
      results,
      answer: null,
      degraded: cfg ? null : { reason: "gateway-not-configured" },
    });
  }

  if (!cfg) {
    return respond({
      query: q,
      mode: "keyword-only",
      results,
      answer: null,
      degraded: { reason: "gateway-not-configured" },
    });
  }

  // Citations/ranking are 1-based POSITIONS into the candidate list the
  // model read at submission time. `results` are re-fetched fresh on every
  // request, so the cache/in-flight key must bind the answer to this exact
  // ordered row set — otherwise a corpus change inside the TTL would remap
  // the numbers onto rows the model never saw (fabricated provenance).
  const fingerprint = results.map((row) => row.chunk_id).join(",");
  const key = `${q}|${sourceId ?? ""}|${count}|${fingerprint}`;
  const store = answerStore();
  const now = Date.now();
  pruneExpired(store, now);

  const cached = store.completed.get(key);
  if (cached) {
    return respond({
      query: q,
      mode: "agentic",
      results,
      answer: { state: "completed", ...cached.result },
      degraded: null,
    });
  }

  const inFlight = store.inFlight.get(key);
  if (inFlight) {
    return respond({
      query: q,
      mode: "agentic",
      results,
      answer: { state: "pending", taskId: inFlight.taskId },
      degraded: null,
    });
  }

  // App-side spend brake, checked only on the true-submit path (cache and
  // in-flight hits above are free).
  if (!takeSubmitToken(store, now)) {
    return respond({
      query: q,
      mode: "keyword-only",
      results,
      answer: null,
      degraded: {
        reason: "synthesis-unavailable",
        detail: SYNTHESIS_UNAVAILABLE_DETAIL,
      },
    });
  }

  try {
    const taskId = await submitSynthesis(cfg, q, results);
    putInFlight(store, key, taskId, now);
    return respond({
      query: q,
      mode: "agentic",
      results,
      answer: { state: "pending", taskId },
      degraded: null,
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      // Keyword results are still good — degrade honestly instead of failing
      // the whole search. GatewayError messages are generic by contract, but
      // we still emit a fixed detail string (never internals).
      return respond({
        query: q,
        mode: "keyword-only",
        results,
        answer: null,
        degraded: {
          reason: "synthesis-unavailable",
          detail: SYNTHESIS_UNAVAILABLE_DETAIL,
        },
      });
    }
    throw err;
  }
}
