import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  INTEL_TASK_ID_RE,
  type AnswerResponse,
  type SynthesisResult,
} from "@/lib/intel/schema";
import {
  GatewayError,
  gatewayFromEnv,
  pollSynthesis,
} from "@/lib/intel/gateway";

/**
 * Phase 2 of Wave-8R agentic search: poll the headless-claude gateway for the
 * answer-synthesis task the search route enqueued. The gateway reports only
 * `pending`/`completed` (crashed or dropped tasks read `pending` forever), so
 * the BROWSER owns the deadline (ANSWER_POLL_DEADLINE_MS) — this route just
 * relays one poll. On a completed poll it back-fills the search route's
 * completed-answer cache so identical queries stop resubmitting.
 */

export const dynamic = "force-dynamic";

/** Completed answers are served from cache for 10 minutes. */
const COMPLETED_TTL_MS = 10 * 60_000;
/** Completed-cache bound; oldest entries are evicted first. */
const COMPLETED_MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Module-level answer store shared with the search route via a `Symbol.for`
// slot on globalThis (Next.js rejects non-handler exports from route modules,
// so the two routes cannot share state through imports). The accessor/prune
// helpers below mirror the search route's verbatim — keep them in sync.
// ---------------------------------------------------------------------------

interface CompletedEntry {
  result: SynthesisResult;
  expiresAt: number;
}

interface InFlightEntry {
  taskId: string;
  expiresAt: number;
}

interface AnswerStore {
  completed: Map<string, CompletedEntry>;
  inFlight: Map<string, InFlightEntry>;
  /** Submission budget — owned/initialized by the SEARCH route; never read
   * here (declared so the two AnswerStore mirrors stay identical). */
  submitBucket?: { tokens: number; lastRefillAt: number };
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

/** Reverse mapping taskId → query key (the in-flight map holds ≤ a few dozen
 * entries — a scan beats maintaining a second index in lockstep). */
function inFlightKeyForTask(store: AnswerStore, taskId: string): string | null {
  for (const [key, entry] of store.inFlight) {
    if (entry.taskId === taskId) return key;
  }
  return null;
}

function putCompleted(
  store: AnswerStore,
  key: string,
  result: SynthesisResult,
  now: number,
): void {
  store.completed.delete(key); // re-put refreshes insertion order
  while (store.completed.size >= COMPLETED_MAX_ENTRIES) {
    const oldest = store.completed.keys().next().value;
    if (oldest === undefined) break;
    store.completed.delete(oldest);
  }
  store.completed.set(key, { result, expiresAt: now + COMPLETED_TTL_MS });
}

// ---------------------------------------------------------------------------

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ taskId: string }> },
): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }

  // Oracle guard: the gateway key is shared across ClaudeCloud clients, so
  // this endpoint only ever relays task ids from OUR `mh-intel-<uuid>`
  // namespace — it must not be usable to read other clients' task results.
  const { taskId } = await context.params;
  if (!INTEL_TASK_ID_RE.test(taskId)) {
    return Response.json({ error: "invalid-task-id" }, { status: 400 });
  }

  const cfg = gatewayFromEnv();
  if (!cfg) {
    const failed: AnswerResponse = {
      state: "failed",
      reason: "gateway-not-configured",
    };
    return Response.json(failed);
  }

  let answer: AnswerResponse;
  try {
    answer = await pollSynthesis(cfg, taskId);
  } catch (err) {
    if (err instanceof GatewayError) {
      // Generic by design (no gateway internals); non-200 = retryable to the
      // browser, which keeps polling until its deadline.
      return Response.json({ error: "gateway-error" }, { status: 502 });
    }
    throw err;
  }

  if (answer.state !== "pending") {
    const store = answerStore();
    const now = Date.now();
    pruneExpired(store, now);
    const key = inFlightKeyForTask(store, taskId);
    if (key !== null) {
      store.inFlight.delete(key);
      if (answer.state === "completed") {
        putCompleted(
          store,
          key,
          {
            answer: answer.answer,
            citations: answer.citations,
            ranking: answer.ranking,
          },
          now,
        );
      }
      // failed: dropping the in-flight entry (without caching) lets the next
      // identical search enqueue a fresh task instead of reusing one whose
      // stored output will never parse (re-polls return the same result).
    }
  }

  return Response.json(answer);
}
