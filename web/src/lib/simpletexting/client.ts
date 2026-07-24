import "server-only";

/**
 * Server-only SimpleTexting v2 API client.
 *
 * Sends a single SMS via `POST /messages` (verified 2026-07-22: the v2 API has
 * no scheduling field — all scheduling, throttling, and retry policy lives in
 * the dispatcher worker). This module performs exactly one POST attempt and
 * classifies the outcome; it holds the bearer token, so it must never be
 * imported from client components.
 */

/** SimpleTexting v2 REST base (verified 2026-07-22). */
const BASE_URL = "https://api-app2.simpletexting.com/v2/api";
/** Per-attempt HTTP budget; past this the outcome is `ambiguous`. */
const HTTP_TIMEOUT_MS = 15_000;
/** Cap stored error detail — `last_error` is an audit field, not a log sink. */
const DETAIL_MAX = 300;

export interface SendSmsInput {
  /** Destination in E.164, e.g. `+15551234567`. */
  phone: string;
  /** Fully rendered message body (no merge fields, no PHI). */
  text: string;
}

/**
 * The classified outcome of one POST attempt — the contract the dispatcher's
 * at-most-once accounting is built on:
 *
 * - `sent`      201 — accepted by SimpleTexting.
 * - `permanent` definitive 4xx rejection; the request was not processed and
 *               retrying the same input cannot succeed.
 * - `config`    credentials problem (401/403 or missing token); release the
 *               claim and back off — a bad token must not burn recipients.
 * - `retryable` transient and provably not processed (429/502/503/504, or the
 *               connection was never established); safe to retry with backoff.
 * - `ambiguous` the request MAY have been processed (timeout, ECONNRESET,
 *               500); never auto-retried — a duplicate patient text is worse
 *               than a missed one.
 */
export type SendResult =
  | { kind: "sent"; id: string | null; credits: number | null }
  | { kind: "permanent"; status: number; detail: string }
  | { kind: "config"; status: number | null; detail: string }
  | { kind: "retryable"; status: number | null; detail: string }
  | { kind: "ambiguous"; status: number | null; detail: string };

/**
 * True when the SimpleTexting API token is configured. The dispatcher idles
 * (graceful degradation) and the UI shows a callout when this is false.
 */
export function isSimpleTextingConfigured(): boolean {
  return Boolean(process.env.SIMPLETEXTING_API_TOKEN);
}

/** Best-effort JSON body parse — a 201 with an odd body is still a send. */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/** Best-effort body text for error detail; never allowed to throw. */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(detail: string): string {
  return detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) : detail;
}

async function classifyResponse(res: Response): Promise<SendResult> {
  if (res.status === 201) {
    const body = await safeJson(res);
    return {
      kind: "sent",
      id: typeof body.id === "string" ? body.id : null,
      credits: typeof body.credits === "number" ? body.credits : null,
    };
  }

  const status = res.status;
  const detail = truncate(`HTTP ${status}: ${await safeText(res)}`);
  // Credentials/config problem — must not burn recipients to `failed`.
  if (status === 401 || status === 403) return { kind: "config", status, detail };
  // Throttled or gateway-rejected before processing — safe to retry.
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return { kind: "retryable", status, detail };
  }
  // The API errored while handling the request — it may have been processed.
  if (status === 500) return { kind: "ambiguous", status, detail };
  // Any other 4xx is a definitive rejection of this exact request.
  if (status >= 400 && status <= 499) return { kind: "permanent", status, detail };
  // Anything unexpected (3xx, other 5xx, non-201 2xx): the request reached
  // the API and the effect is unknown — ambiguous, never auto-retried.
  return { kind: "ambiguous", status, detail };
}

/**
 * Failures where the connection was provably never established, so the
 * request cannot have been processed: duplicate-free to retry.
 */
const PRE_CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Extract a Node system-error code. undici's fetch wraps system errors as
 * `TypeError: fetch failed` with the coded error on `cause`; direct
 * rejections (and our tests) carry `code` on the error itself.
 */
function errorCode(err: unknown): string | null {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (candidate && typeof candidate === "object") {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function describeError(err: unknown, code: string | null): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    const suffix = code && !`${err.message}${cause}`.includes(code) ? ` (${code})` : "";
    return `${err.name}: ${err.message}${cause}${suffix}`;
  }
  return String(err);
}

function classifyRejection(err: unknown): SendResult {
  const code = errorCode(err);
  const detail = truncate(describeError(err, code));
  if (code && PRE_CONNECTION_CODES.has(code)) {
    return { kind: "retryable", status: null, detail };
  }
  // Timeout (AbortError/TimeoutError from AbortSignal.timeout), ECONNRESET,
  // and anything unrecognized: the request may have reached SimpleTexting —
  // ambiguous, never auto-retried.
  return { kind: "ambiguous", status: null, detail };
}

/**
 * POST one SMS to SimpleTexting and classify the outcome. NEVER throws — the
 * dispatcher depends on every attempt resolving to exactly one `SendResult`.
 */
export async function sendSms(input: SendSmsInput): Promise<SendResult> {
  const token = process.env.SIMPLETEXTING_API_TOKEN;
  if (!token) {
    return {
      kind: "config",
      status: null,
      detail: "SIMPLETEXTING_API_TOKEN is not set",
    };
  }

  const accountPhone = process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  const payload: Record<string, string> = {
    contactPhone: input.phone,
    text: input.text,
    mode: "AUTO",
    ...(accountPhone ? { accountPhone } : {}),
  };

  try {
    const res = await fetch(`${BASE_URL}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return await classifyResponse(res);
  } catch (err) {
    return classifyRejection(err);
  }
}
