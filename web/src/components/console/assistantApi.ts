// Browser-side client for the console SQL assistant routes
// (/api/console/assistant*). Mirrors components/intel/api.ts: the panel never
// imports the server module (lib/console/assistant.ts is server-only via
// pg-meta), so wire shapes are validated HERE and a malformed payload
// degrades honestly — never a crash, never a poll against `undefined`.
//
// Shapes mirror the route responses exactly:
//   POST /api/console/assistant { question } →
//        { answer: {state:"pending",taskId}
//                | {state:"completed",explanation,sql}   (completed-cache hit)
//                | null,
//          degraded: {reason} | null }
//   GET  /api/console/assistant/answer/:taskId →
//        {state:"pending"} | {state:"completed",explanation,sql}
//        | {state:"failed",reason}
// Errors: { error, message? } — generic by design (gateway internals never
// reach the browser); a non-200 from the answer poll is retryable until the
// client-owned deadline below.

/** Browser poll cadence for the async assistant answer. */
export const ASSISTANT_POLL_INTERVAL_MS = 3000;

/**
 * Client-owned deadline: the gateway has NO failed state (crashed or dropped
 * tasks read `pending` forever), so the browser must stop on its own. The
 * server module's constants are server-only, so the browser's copy of this
 * contract lives here — same 90 s as intel's ANSWER_POLL_DEADLINE_MS.
 */
export const ASSISTANT_POLL_DEADLINE_MS = 90_000;

/** Client-side bound on ONE poll round trip. The server bounds its gateway
 * leg at ~10s; this keeps a stalled proxy/relay from pinning a poll open,
 * since the panel's 90s deadline is only checked after each poll settles. */
const POLL_FETCH_TIMEOUT_MS = 15_000;

export type AssistantApiErrorKind = "http" | "network";

/** Typed failure for the assistant API calls — message stays terse/generic. */
export class AssistantApiError extends Error {
  readonly kind: AssistantApiErrorKind;
  readonly status: number | null;

  constructor(kind: AssistantApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AssistantApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** The completed proposal: plain-text explanation + optional SQL. The SQL is
 * a PROPOSAL for the editor — nothing in this client ever executes it. */
export interface AssistantProposal {
  explanation: string;
  sql: string | null;
}

export type AssistantAnswer =
  | { state: "pending"; taskId: string }
  | ({ state: "completed" } & AssistantProposal);

export interface AskResponse {
  answer: AssistantAnswer | null;
  degraded: { reason: string } | null;
}

export type AssistantPollResult =
  | { state: "pending" }
  | ({ state: "completed" } & AssistantProposal)
  | { state: "failed"; reason: string };

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new AssistantApiError("network", "Network error — please try again.");
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : null;
    const message =
      (typeof record.message === "string" ? record.message : null) ??
      code ??
      `Request failed (${res.status}).`;
    throw new AssistantApiError("http", message, res.status);
  }
  return body;
}

/**
 * Validate a wire answer object into the shapes the panel dereferences.
 * `state` alone is NOT trusted: a "completed" without a string `explanation`
 * would render undefined, and a "pending" without a taskId would poll
 * `/answer/undefined` for the full deadline. A blank/absent/non-string `sql`
 * coerces to null (the contract allows null — same stance as the server
 * parser). Malformed ⇒ null (caller degrades / keeps waiting).
 */
function normalizeAnswer(value: unknown): AssistantAnswer | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (a.state === "pending") {
    return typeof a.taskId === "string" && a.taskId.length > 0
      ? { state: "pending", taskId: a.taskId }
      : null;
  }
  if (
    a.state === "completed" &&
    typeof a.explanation === "string" &&
    a.explanation.length > 0
  ) {
    return {
      state: "completed",
      explanation: a.explanation,
      sql: typeof a.sql === "string" && a.sql.trim().length > 0 ? a.sql : null,
    };
  }
  return null;
}

/**
 * Ask the assistant one question. The route answers immediately: a pending
 * taskId to poll (or a completed-cache hit), or `answer: null` with a
 * `degraded` marker — gateway env absent / submissions unavailable — which
 * the panel maps to its honest one-liner.
 */
export async function askAssistant(question: string): Promise<AskResponse> {
  const json = (await request("/api/console/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  })) as { answer?: unknown; degraded?: unknown } | null;
  const degraded =
    json?.degraded && typeof json.degraded === "object"
      ? (json.degraded as Record<string, unknown>)
      : null;
  return {
    answer: normalizeAnswer(json?.answer),
    degraded: degraded
      ? { reason: typeof degraded.reason === "string" ? degraded.reason : "unknown" }
      : null,
  };
}

/**
 * Poll the async assistant answer. 200 payloads are VALIDATED into the typed
 * result; a malformed body reads as `pending` (the caller's deadline bounds
 * retries). Non-200s throw AssistantApiError — also retryable, because the
 * gateway itself has no failed state (see ASSISTANT_POLL_DEADLINE_MS).
 */
export async function pollAssistantAnswer(taskId: string): Promise<AssistantPollResult> {
  const json = (await request(
    `/api/console/assistant/answer/${encodeURIComponent(taskId)}`,
    { signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS) },
  )) as Record<string, unknown> | null;
  const completed = normalizeAnswer(json);
  if (completed?.state === "completed") return completed;
  if (json && typeof json === "object" && json.state === "failed") {
    return {
      state: "failed",
      reason: typeof json.reason === "string" ? json.reason : "unknown",
    };
  }
  return { state: "pending" };
}
