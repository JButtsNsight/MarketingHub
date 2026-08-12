import { AuthError, requireUser } from "@/lib/auth";
import { MARKETING_GROUP } from "@/lib/authGroups";
import { GatewayError, gatewayFromEnv } from "@/lib/gateway/hardening";
import {
  ASSISTANT_TASK_ID_RE,
  pollAssistant,
  type AssistantAnswer,
  type AssistantResult,
} from "@/lib/console/assistant";

/**
 * Console SQL assistant, phase 2 (Round 2 Track C2): poll the headless-claude
 * gateway for the assistant task the POST route enqueued. The gateway reports
 * only `pending`/`completed` (crashed or dropped tasks read `pending`
 * forever), so the BROWSER owns the deadline — this route just relays one
 * budgeted poll (token bucket below; the submit bucket does not cover GETs).
 * On a completed poll it back-fills the POST route's completed-answer cache
 * so identical questions stop resubmitting.
 *
 * Relayed output is a PROPOSAL only — nothing here (or anywhere in the
 * assistant) executes SQL; the editor's classify → confirm-write path does.
 */

export const dynamic = "force-dynamic";

/** Completed answers are served from cache for 10 minutes. */
const COMPLETED_TTL_MS = 10 * 60_000;
/** Completed-cache bound; oldest entries are evicted first. */
const COMPLETED_MAX_ENTRIES = 50;

/**
 * Per-process budget on relayed gateway polls: burst of 30 (one task's full
 * lifetime — the client polls every 3 s against a 90 s deadline), then one
 * every 500 ms (≤2 rps sustained). The submit-side bucket only gates POST
 * /api/console/assistant; without this, a scripted user looping well-formed
 * `mh-sqlast-*` ids could drive unbounded gateway GETs on the ACCOUNT-WIDE
 * 10 rps ClaudeCloud throttle shared with other clients. Exhaustion answers
 * 429 (never a gateway round trip) — retryable to the browser, whose
 * deadline bounds the retries.
 */
const POLL_BURST = 30;
const POLL_REFILL_MS = 500;

// ---------------------------------------------------------------------------
// Module-level answer store shared with the POST route via a `Symbol.for`
// slot on globalThis (Next.js rejects non-handler exports from route modules,
// so the two routes cannot share state through imports). The accessor/prune
// helpers below mirror the POST route's verbatim — keep them in sync.
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
  /** Submission budget — owned/initialized by the POST route; never read
   * here (declared so the two AnswerStore mirrors stay identical). */
  submitBucket?: TokenBucket;
  /** Poll-relay budget — owned/initialized by this route; lazily initialized. */
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

/** Reverse mapping taskId → question key (the in-flight map holds ≤ a few
 * dozen entries — a scan beats maintaining a second index in lockstep). */
function inFlightKeyForTask(store: AnswerStore, taskId: string): string | null {
  for (const [key, entry] of store.inFlight) {
    if (entry.taskId === taskId) return key;
  }
  return null;
}

/** Take one poll token; false = budget exhausted (429, no gateway poll). */
function takePollToken(store: AnswerStore, now: number): boolean {
  let bucket = store.pollBucket;
  if (!bucket) {
    bucket = { tokens: POLL_BURST, lastRefillAt: now };
    store.pollBucket = bucket;
  }
  const elapsed = now - bucket.lastRefillAt;
  if (elapsed > 0) {
    bucket.tokens = Math.min(
      POLL_BURST,
      bucket.tokens + elapsed / POLL_REFILL_MS,
    );
    bucket.lastRefillAt = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function putCompleted(
  store: AnswerStore,
  key: string,
  result: AssistantResult,
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
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  // Oracle guard: the gateway key is shared across ClaudeCloud clients, so
  // this endpoint only ever relays task ids from OUR `mh-sqlast-<uuid>`
  // namespace — it must not be usable to read other clients' (or intel's)
  // task results. 404, not 400: a foreign id simply does not exist here, and
  // the response must reveal nothing about whether it exists anywhere else.
  const { taskId } = await context.params;
  if (!ASSISTANT_TASK_ID_RE.test(taskId)) {
    return Response.json({ error: "invalid-task-id" }, { status: 404 });
  }

  const cfg = gatewayFromEnv();
  if (!cfg) {
    const failed: AssistantAnswer = {
      state: "failed",
      reason: "gateway-not-configured",
    };
    return Response.json(failed);
  }

  // App-side relay brake: every request past this point is one live gateway
  // round trip on the shared account throttle — budget it.
  const store = answerStore();
  if (!takePollToken(store, Date.now())) {
    return Response.json({ error: "rate-limited" }, { status: 429 });
  }

  let answer: AssistantAnswer;
  try {
    answer = await pollAssistant(cfg, taskId);
  } catch (err) {
    if (err instanceof GatewayError) {
      // Generic by design (no gateway internals); non-200 = retryable to the
      // browser, which keeps polling until its deadline.
      return Response.json({ error: "gateway-error" }, { status: 502 });
    }
    throw err;
  }

  if (answer.state !== "pending") {
    const now = Date.now();
    pruneExpired(store, now);
    const key = inFlightKeyForTask(store, taskId);
    if (key !== null) {
      store.inFlight.delete(key);
      if (answer.state === "completed") {
        putCompleted(
          store,
          key,
          { explanation: answer.explanation, sql: answer.sql },
          now,
        );
      }
      // failed: dropping the in-flight entry (without caching) lets the next
      // identical question enqueue a fresh task instead of reusing one whose
      // stored output will never parse (re-polls return the same result).
    }
  }

  return Response.json(answer);
}
