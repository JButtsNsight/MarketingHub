import "server-only";

/**
 * Server-only Monday.com GraphQL client.
 *
 * One POST per call to the v2 GraphQL endpoint (verified 2026-07-22: bearer
 * auth + `API-Version: 2024-01`). This module holds the API token, so it must
 * never be imported from client components. Board-shaped helpers live in
 * `boards.ts`; this file owns transport + error classification only.
 */

/** Monday.com GraphQL endpoint (verified 2026-07-22). */
const MONDAY_API_URL = "https://api.monday.com/v2";
/** Pinned API version — pagination/PhoneValue shapes are version-dependent. */
const MONDAY_API_VERSION = "2024-01";
/** Per-request HTTP budget. */
const HTTP_TIMEOUT_MS = 15_000;
/** Cap error detail — messages end up in logs/responses, not a body sink. */
const DETAIL_MAX = 300;

/**
 * The Monday integration is not configured (no `MONDAY_API_TOKEN`). Routes
 * map this to 503 so the UI can show its "not configured" callout.
 */
export class MondayConfigError extends Error {
  constructor(message = "MONDAY_API_TOKEN is not set") {
    super(message);
    this.name = "MondayConfigError";
  }
}

/**
 * The Monday API rejected or failed the request: HTTP status ≠ 200, a
 * GraphQL `errors[]` payload, or an unusable response body.
 */
export class MondayApiError extends Error {
  /** HTTP status of the response (200 when the failure is GraphQL-level). */
  readonly status: number;
  /** Raw GraphQL `errors` array when present (empty for HTTP-level failures). */
  readonly errors: readonly unknown[];
  /**
   * The `Retry-After` response header in seconds, when present and numeric
   * (Monday's hard per-minute rate limit sends `Retry-After: 60` on its 429
   * with no hint in the body). Undefined otherwise — HTTP-date form is rare
   * enough to ignore. Retry loops (lib/monday/writes) honor this first.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    errors: readonly unknown[] = [],
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MondayApiError";
    this.status = status;
    this.errors = errors;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Numeric `Retry-After` header in seconds, or undefined. Never throws. */
function retryAfterSecondsOf(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * True when the Monday API token is configured. No board is linked at first
 * deploy — the campaigns UI degrades to a callout when this is false.
 */
export function isMondayConfigured(): boolean {
  return Boolean(process.env.MONDAY_API_TOKEN);
}

function truncate(detail: string): string {
  return detail.length > DETAIL_MAX ? detail.slice(0, DETAIL_MAX) : detail;
}

/** Best-effort body text for error detail; never allowed to throw. */
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** First GraphQL error message, tolerantly extracted from unknown shapes. */
function firstErrorMessage(errors: readonly unknown[]): string {
  const first = errors[0];
  if (first && typeof first === "object") {
    const message = (first as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "unknown GraphQL error";
}

/**
 * Execute one GraphQL document against the Monday v2 API and return its
 * `data` payload. Throws `MondayConfigError` when the token is unset/empty
 * and `MondayApiError` for HTTP ≠ 200, GraphQL `errors[]` (partial results
 * are not trusted), or a malformed response body.
 */
export async function mondayGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new MondayConfigError();

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "API-Version": MONDAY_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (res.status !== 200) {
    throw new MondayApiError(
      truncate(`Monday API HTTP ${res.status}: ${await safeText(res)}`),
      res.status,
      [],
      retryAfterSecondsOf(res),
    );
  }

  let body: { data?: T; errors?: unknown };
  try {
    body = (await res.json()) as { data?: T; errors?: unknown };
  } catch {
    throw new MondayApiError(
      "Monday API returned a non-JSON 200 response",
      res.status,
    );
  }

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new MondayApiError(
      truncate(`Monday GraphQL error: ${firstErrorMessage(body.errors)}`),
      res.status,
      body.errors,
    );
  }

  if (body.data === undefined || body.data === null) {
    throw new MondayApiError(
      "Monday API returned a 200 response without data",
      res.status,
    );
  }

  return body.data;
}
