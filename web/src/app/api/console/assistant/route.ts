import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { GatewayError, gatewayFromEnv } from "@/lib/gateway/hardening";
import {
  buildSchemaContext,
  submitAssistant,
  type AssistantResult,
} from "@/lib/console/assistant";

/**
 * Console SQL assistant, phase 1 (Round 2 Track C2 — the W7 "Supabase AI"
 * equivalent on headless-claude). POST a natural-language question; when the
 * gateway is configured an assistant task is enqueued and the browser polls
 * /api/console/assistant/answer/[taskId] until completed/failed or its
 * deadline (the gateway has NO failed state — the client owns the clock).
 *
 * Security posture (non-negotiable, see lib/console/assistant.ts):
 * - Nothing here executes SQL. The task's output is a PROPOSAL the panel
 *   inserts into the editor; Run flows through /api/console/sql's classify →
 *   confirm-write path.
 * - Gateway egress is schema METADATA only (pg-meta tables/columns/policies),
 *   injection-neutralized in buildSchemaContext — never row data.
 * - Degradation is honest and generic: env absent, budget dry, or a gateway
 *   failure all answer `{answer:null, degraded:{reason:"assistant-unavailable"}}`
 *   — never a 5xx, never gateway internals.
 *
 * Marketing-gated (not admin): the assistant is a Platform /sql surface, and
 * /sql itself sits behind the platform section gate (Wave D).
 */

export const dynamic = "force-dynamic";

/** Identical questions reuse the in-flight assistant task for 5 minutes. */
const IN_FLIGHT_TTL_MS = 5 * 60_000;

/** In-flight map bound (the completed cache has its own 50-entry bound in the
 * answer route) — a burst of unique questions must not grow the map without
 * limit; oldest entries are evicted first. */
const IN_FLIGHT_MAX_ENTRIES = 200;

/**
 * Per-process budget on gateway task submissions: burst of 5, then one every
 * 5 s (≤12/min sustained) — tighter than intel search because each assistant
 * task carries a full schema-context prompt (pricier opus spend), and the
 * account-wide 10 rps gateway throttle is shared with other ClaudeCloud
 * clients. Exhaustion degrades honestly (`assistant-unavailable`).
 */
const SUBMIT_BURST = 5;
const SUBMIT_REFILL_MS = 5_000;

// ---------------------------------------------------------------------------
// Module-level answer store, shared with the answer route via a `Symbol.for`
// slot on globalThis (Next.js rejects non-handler exports from route modules,
// so the two routes cannot share state through imports). Process-local and
// best-effort: a cold miss only costs one extra gateway task.
//   completed: question → AssistantResult (10-min TTL, ≤50 entries; WRITTEN
//              by the answer route when a poll completes)
//   inFlight:  question → taskId (5-min TTL; written here)
// Unlike intel search, the key is the QUESTION alone — assistant answers are
// self-contained prose + SQL with no positional citations binding them to a
// retrieved row set, so there is no fingerprint to pin. Schema drift inside
// the TTLs can at worst serve a slightly stale proposal, and every proposal
// still faces the editor's classify → confirm-write path before it runs.
// The accessor/prune helpers are mirrored verbatim in answer/[taskId]/route.ts.
// ---------------------------------------------------------------------------

interface CompletedEntry {
  result: AssistantResult;
  expiresAt: number;
}

interface InFlightEntry {
  taskId: string;
  expiresAt: number;
}

interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
}

interface AnswerStore {
  completed: Map<string, CompletedEntry>;
  inFlight: Map<string, InFlightEntry>;
  /** Submission budget — used only by this route; lazily initialized. */
  submitBucket?: TokenBucket;
  /** Poll-relay budget — owned/initialized by the answer route; never read
   * here (declared so the two AnswerStore mirrors stay identical). */
  pollBucket?: TokenBucket;
}

const STORE_KEY = Symbol.for("marketinghub.console.assistant-answer-store");

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

/** Response of POST /api/console/assistant (async two-phase UX, intel-style
 * envelope: an answer slot plus an honest degraded marker — the panel client
 * in components/console/assistantApi.ts validates exactly this shape). */
interface AssistantAskResponse {
  answer:
    | { state: "pending"; taskId: string }
    | ({ state: "completed" } & AssistantResult)
    | null;
  degraded: { reason: "assistant-unavailable" } | null;
}

/** Generic by design: degraded responses must never leak gateway internals. */
const DEGRADED: AssistantAskResponse = {
  answer: null,
  degraded: { reason: "assistant-unavailable" },
};

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

function respond(body: AssistantAskResponse): Response {
  return Response.json(body);
}

const PostBodySchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "question is required")
    .max(2000, "question must be 2000 characters or fewer"),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PostBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { question } = parsed.data;

  // Env unset ⇒ honest one-line degraded state — never an error, and never a
  // pg-meta introspection (no reason to read metadata we cannot send).
  const cfg = gatewayFromEnv();
  if (!cfg) return respond(DEGRADED);

  const store = answerStore();
  const now = Date.now();
  pruneExpired(store, now);

  const cached = store.completed.get(question);
  if (cached) {
    return respond({
      answer: { state: "completed", ...cached.result },
      degraded: null,
    });
  }

  const inFlight = store.inFlight.get(question);
  if (inFlight) {
    return respond({
      answer: { state: "pending", taskId: inFlight.taskId },
      degraded: null,
    });
  }

  // App-side spend brake, checked only on the true-submit path (cache and
  // in-flight hits above are free) and BEFORE the pg-meta introspection.
  if (!takeSubmitToken(store, now)) return respond(DEGRADED);

  // pg-meta failures propagate (500) — a broken console backend is not a
  // gateway degradation, and hiding it would mask a real outage.
  const schemaContext = await buildSchemaContext();

  try {
    const taskId = await submitAssistant(cfg, question, schemaContext);
    putInFlight(store, question, taskId, now);
    return respond({ answer: { state: "pending", taskId }, degraded: null });
  } catch (err) {
    if (err instanceof GatewayError) {
      // GatewayError messages are generic by contract, but the body stays a
      // fixed marker anyway — never gateway internals.
      return respond(DEGRADED);
    }
    throw err;
  }
}
