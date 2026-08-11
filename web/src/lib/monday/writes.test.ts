// @vitest-environment node
// The writer is server-only mutation code used by the write-back worker;
// node env matches client.test.ts (no jsdom fetch shims in play — the
// GraphQL transport itself is injected here).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { MondayApiError, MondayConfigError } from "./client";
import {
  createMondayWriter,
  isRetryableMondayError,
  type ColumnValueWrite,
} from "./writes";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/monday/writes.ts");

const WRITE: ColumnValueWrite = {
  boardId: "1111",
  itemId: "999",
  columnId: "text_col",
  value: "delivered 2026-08-11",
};

/** Writer with a scripted graphql fake and a recording (instant) sleep. */
function makeWriter(
  results: Array<unknown | Error>,
  config: { ratePerSecond?: number; maxAttempts?: number } = {},
) {
  const graphqlCalls: Array<{ query: string; variables: unknown }> = [];
  const graphql = async <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    graphqlCalls.push({ query, variables });
    const next = results.shift();
    if (next instanceof Error) throw next;
    return (next ?? { change_simple_column_value: { id: "999" } }) as T;
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
  };
  const writer = createMondayWriter(config, { graphql, sleep });
  return { writer, graphqlCalls, sleeps };
}

const rateLimited = () => new MondayApiError("Monday API HTTP 429: slow down", 429);

describe("module contract", () => {
  test('import "server-only" is the first line', () => {
    const firstLine = readFileSync(SRC, "utf8").split("\n")[0];
    expect(firstLine).toBe('import "server-only";');
  });
});

describe("isRetryableMondayError", () => {
  test("HTTP 429 is retryable", () => {
    expect(isRetryableMondayError(rateLimited())).toBe(true);
  });

  test("complexity-budget GraphQL errors (HTTP 200) are retryable — by message or extensions code", () => {
    expect(
      isRetryableMondayError(
        new MondayApiError(
          "Monday GraphQL error: Complexity budget exhausted, reset in 12 seconds",
          200,
        ),
      ),
    ).toBe(true);
    expect(
      isRetryableMondayError(
        new MondayApiError("Monday GraphQL error: denied", 200, [
          { message: "budget gone", extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED" } },
        ]),
      ),
    ).toBe(true);
  });

  test("config errors, other API errors and plain errors are not", () => {
    expect(isRetryableMondayError(new MondayConfigError())).toBe(false);
    expect(
      isRetryableMondayError(new MondayApiError("Monday API HTTP 403: nope", 403)),
    ).toBe(false);
    expect(
      isRetryableMondayError(
        new MondayApiError("Monday GraphQL error: column not found", 200, [
          { message: "column not found" },
        ]),
      ),
    ).toBe(false);
    expect(isRetryableMondayError(new Error("Complexity budget exhausted"))).toBe(
      false,
    );
  });
});

describe("writeColumnValue — mutation shape", () => {
  test("issues one change_simple_column_value mutation with the exact variables", async () => {
    const { writer, graphqlCalls, sleeps } = makeWriter([undefined]);

    await writer.writeColumnValue(WRITE);

    expect(graphqlCalls).toHaveLength(1);
    expect(graphqlCalls[0].query).toContain("change_simple_column_value");
    expect(graphqlCalls[0].variables).toEqual({
      boardId: "1111",
      itemId: "999",
      columnId: "text_col",
      value: "delivered 2026-08-11",
    });
    // First-ever attempt is never throttled.
    expect(sleeps).toEqual([]);
  });
});

describe("writeColumnValue — throttle (mirrors the dispatcher's 1000/rate)", () => {
  test("a second write sleeps 1000/ratePerSecond first", async () => {
    const { writer, sleeps } = makeWriter([undefined, undefined], {
      ratePerSecond: 4,
    });

    await writer.writeColumnValue(WRITE);
    await writer.writeColumnValue({ ...WRITE, itemId: "1000" });

    expect(sleeps).toEqual([250]);
  });

  test("default rate is 2/s (500 ms gap)", async () => {
    const { writer, sleeps } = makeWriter([undefined, undefined]);

    await writer.writeColumnValue(WRITE);
    await writer.writeColumnValue(WRITE);

    expect(sleeps).toEqual([500]);
  });

  test("a failed attempt still counts for pacing — the next write is throttled", async () => {
    const { writer, sleeps } = makeWriter([
      new MondayApiError("Monday API HTTP 403: nope", 403),
      undefined,
    ]);

    await expect(writer.writeColumnValue(WRITE)).rejects.toThrow(/403/);
    await writer.writeColumnValue(WRITE);

    expect(sleeps).toEqual([500]);
  });
});

describe("writeColumnValue — retry with backoff", () => {
  test("429 retries: backoff sleep (5s · 2^(n−1)) then a throttled retry that succeeds", async () => {
    const { writer, graphqlCalls, sleeps } = makeWriter([
      rateLimited(),
      undefined,
    ]);

    await writer.writeColumnValue(WRITE);

    expect(graphqlCalls).toHaveLength(2);
    // [backoff after attempt 1, throttle before attempt 2]
    expect(sleeps).toEqual([5_000, 500]);
  });

  test('a complexity error\'s "reset in N seconds" hint sets the backoff, capped at 60 s', async () => {
    const complexity = (seconds: number) =>
      new MondayApiError(
        `Monday GraphQL error: Complexity budget exhausted, reset in ${seconds} seconds`,
        200,
      );
    const { writer, sleeps } = makeWriter([complexity(12), undefined]);
    await writer.writeColumnValue(WRITE);
    expect(sleeps).toEqual([12_000, 500]);

    const capped = makeWriter([complexity(999), undefined]);
    await capped.writer.writeColumnValue(WRITE);
    expect(capped.sleeps).toEqual([60_000, 500]);
  });

  test('a FRACTIONAL "reset in N seconds" hint is honored (rounded up), not dropped to exponential', async () => {
    const { writer, sleeps } = makeWriter([
      new MondayApiError(
        "Monday GraphQL error: Complexity budget exhausted, reset in 4.24 seconds",
        200,
      ),
      undefined,
    ]);
    await writer.writeColumnValue(WRITE);
    expect(sleeps).toEqual([4_240, 500]);
  });

  test("the 429 Retry-After header outranks the exponential backoff — the retry lands OUTSIDE the minute window", async () => {
    // The hard per-minute rate limit: HTTP 429, `Retry-After: 60`, NO body
    // hint. 5s/10s backoff would burn every attempt inside the same window.
    const { writer, sleeps } = makeWriter([
      new MondayApiError("Monday API HTTP 429: rate limited", 429, [], 60),
      undefined,
    ]);
    await writer.writeColumnValue(WRITE);
    expect(sleeps).toEqual([60_000, 500]);
  });

  test("a Retry-After hint is capped at 60 s like the body hint", async () => {
    const { writer, sleeps } = makeWriter([
      new MondayApiError("Monday API HTTP 429: rate limited", 429, [], 300),
      undefined,
    ]);
    await writer.writeColumnValue(WRITE);
    expect(sleeps).toEqual([60_000, 500]);
  });

  test("retries exhaust after maxAttempts and the last error is thrown", async () => {
    const { writer, graphqlCalls, sleeps } = makeWriter([
      rateLimited(),
      rateLimited(),
      rateLimited(),
    ]);

    await expect(writer.writeColumnValue(WRITE)).rejects.toThrow(/429/);

    expect(graphqlCalls).toHaveLength(3);
    // backoff 5s → throttle → backoff 10s → throttle → final attempt throws.
    expect(sleeps).toEqual([5_000, 500, 10_000, 500]);
  });

  test("non-retryable API errors throw immediately (one call, no backoff)", async () => {
    const { writer, graphqlCalls, sleeps } = makeWriter([
      new MondayApiError("Monday GraphQL error: column not found", 200, [
        { message: "column not found" },
      ]),
    ]);

    await expect(writer.writeColumnValue(WRITE)).rejects.toThrow(
      /column not found/,
    );
    expect(graphqlCalls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("MondayConfigError propagates untouched — the consumer's idle path handles it", async () => {
    const { writer, graphqlCalls } = makeWriter([new MondayConfigError()]);

    await expect(writer.writeColumnValue(WRITE)).rejects.toThrow(
      MondayConfigError,
    );
    expect(graphqlCalls).toHaveLength(1);
  });
});
