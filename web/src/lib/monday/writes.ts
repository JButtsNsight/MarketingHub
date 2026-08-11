import "server-only";

import { MondayApiError, mondayGraphQL } from "./client";

/**
 * Server-only Monday.com column WRITE transport — the write-back worker's
 * only mutation path. Reads stay in `boards.ts`; this file owns the outcome
 * mutation plus the paced, retried delivery the consumer relies on.
 *
 * Mutation choice: `change_simple_column_value` over
 * `change_multiple_column_values`. The write-back writes exactly ONE
 * per-list-configured column per item, so multi-column batching buys
 * nothing — and the simple mutation takes the value as a plain string that
 * Monday coerces per column type (a text column stores it verbatim; a status
 * column matches it against its labels), while the multi mutation demands a
 * JSON object with column-TYPE-specific value shapes we cannot know for a
 * user-picked column. A value the column cannot hold fails loud as a GraphQL
 * error either way. `create_labels_if_missing` is deliberately NOT set:
 * outcome strings are dated, and auto-creating one status label per date
 * would trash a status column — the documented target is a text column.
 *
 * Pacing/retry (the raw client has none):
 * - every mutation attempt after this writer's first is preceded by a
 *   `1000 / ratePerSecond` throttle sleep (mirrors the dispatcher's
 *   sequential POST throttle — Monday's per-minute complexity budget);
 * - 429s and complexity-budget errors are retried with backoff (the 429's
 *   `Retry-After` header first, then the body's "reset in N seconds" hint,
 *   else 5s · 2^(attempt−1)), at most `maxAttempts` attempts per write;
 * - everything else (bad column id, missing item, auth) throws immediately —
 *   the consumer records the row's error and the next poll re-derives it.
 */

/** Mutation attempts per write (1 initial + retries) for 429/complexity. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Writes per second — mirrors the dispatcher's sequential 1000/rate sleep. */
const DEFAULT_RATE_PER_SECOND = 2;
/** Retry backoff base: 5s · 2^(attempt−1), unless Monday names a reset delay. */
const RETRY_BACKOFF_BASE_MS = 5_000;
/** Ceiling for a Monday-provided delay hint (Retry-After / "reset in N s"). */
const RESET_HINT_MAX_MS = 60_000;

const CHANGE_SIMPLE_COLUMN_VALUE = `
  mutation WriteBackColumnValue($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
    change_simple_column_value(
      board_id: $boardId,
      item_id: $itemId,
      column_id: $columnId,
      value: $value
    ) {
      id
    }
  }
`;

/** One column write: board + item + column coordinates and the plain value. */
export interface ColumnValueWrite {
  boardId: string;
  itemId: string;
  columnId: string;
  /** Plain-string value; Monday coerces it per column type. */
  value: string;
}

export interface MondayWriterConfig {
  /** Throttle: sleep(1000 / ratePerSecond) before every non-first attempt. */
  ratePerSecond: number;
  /** Attempts per write for retryable (429/complexity) failures. */
  maxAttempts: number;
}

/** Injectable seams — production wiring is the real client + a timer sleep. */
export interface MondayWriterDeps {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  sleep(ms: number): Promise<void>;
}

export interface MondayWriter {
  /** One paced, retried column write; throws when undeliverable. */
  writeColumnValue(input: ColumnValueWrite): Promise<void>;
}

/**
 * True for the two failure modes worth an in-call retry: HTTP 429 and
 * Monday's complexity-budget GraphQL errors (which arrive as HTTP 200 with
 * an `errors[]` payload). Config errors and everything else are not — a bad
 * token or column id does not get better by waiting.
 */
export function isRetryableMondayError(err: unknown): boolean {
  if (!(err instanceof MondayApiError)) return false;
  if (err.status === 429) return true;
  if (/complexity/i.test(err.message)) return true;
  return err.errors.some((e) => {
    if (!e || typeof e !== "object") return false;
    const { message, extensions } = e as {
      message?: unknown;
      extensions?: { code?: unknown };
    };
    return (
      (typeof message === "string" && /complexity/i.test(message)) ||
      (typeof extensions === "object" &&
        extensions !== null &&
        typeof extensions.code === "string" &&
        /complexity/i.test(extensions.code))
    );
  });
}

/**
 * Delay before the next attempt, best hint first:
 * 1. the `Retry-After` header (the hard per-minute rate limit's 429 carries
 *    `Retry-After: 60` and NO body hint — exponential 5s/10s backoff would
 *    burn every attempt inside the same 60s window);
 * 2. the complexity-budget body hint "reset in N seconds" (N can be
 *    fractional: "reset in 4.24 seconds");
 * 3. else 5s · 2^(attempt−1). Hints are capped at RESET_HINT_MAX_MS.
 */
function retryDelayMs(err: unknown, attempt: number): number {
  if (err instanceof MondayApiError) {
    if (err.retryAfterSeconds !== undefined) {
      return Math.min(
        Math.ceil(err.retryAfterSeconds * 1000),
        RESET_HINT_MAX_MS,
      );
    }
    const hint = /reset in (\d+(?:\.\d+)?)\s*seconds?/i.exec(err.message);
    if (hint) {
      return Math.min(Math.ceil(Number(hint[1]) * 1000), RESET_HINT_MAX_MS);
    }
  }
  return RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

export function createMondayWriter(
  config: Partial<MondayWriterConfig> = {},
  overrides: Partial<MondayWriterDeps> = {},
): MondayWriter {
  const ratePerSecond = config.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deps: MondayWriterDeps = {
    graphql: mondayGraphQL,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
  const throttleMs = 1000 / ratePerSecond;
  /** True once any attempt hit the API — every later attempt is paced. */
  let attempted = false;

  async function writeColumnValue(input: ColumnValueWrite): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      if (attempted) await deps.sleep(throttleMs);
      attempted = true;
      try {
        await deps.graphql(CHANGE_SIMPLE_COLUMN_VALUE, {
          boardId: input.boardId,
          itemId: input.itemId,
          columnId: input.columnId,
          value: input.value,
        });
        return;
      } catch (err) {
        if (attempt >= maxAttempts || !isRetryableMondayError(err)) throw err;
        await deps.sleep(retryDelayMs(err, attempt));
      }
    }
  }

  return { writeColumnValue };
}
