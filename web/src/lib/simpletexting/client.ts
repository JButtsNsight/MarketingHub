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

async function classifyResponse(res: Response): Promise<SendResult> {
  if (res.status === 201) {
    const body = await safeJson(res);
    return {
      kind: "sent",
      id: typeof body.id === "string" ? body.id : null,
      credits: typeof body.credits === "number" ? body.credits : null,
    };
  }
  // Non-201 classification lands in the full classification table.
  return {
    kind: "ambiguous",
    status: res.status,
    detail: `HTTP ${res.status}`,
  };
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
  } catch {
    return { kind: "ambiguous", status: null, detail: "request failed" };
  }
}
