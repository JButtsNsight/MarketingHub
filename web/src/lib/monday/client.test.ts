// @vitest-environment node
// The Monday client is server-only fetch code used by API routes; node env
// exercises the real undici Response/AbortSignal implementations (no jsdom
// fetch shims).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MondayApiError,
  MondayConfigError,
  isMondayConfigured,
  mondayGraphQL,
} from "./client";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/monday/client.ts");

const OLD_ENV = { ...process.env };

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

/** Stub global fetch; returns the mock so tests can inspect the call. */
function stubFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const mock = vi.fn<(...args: FetchArgs) => Promise<Response>>(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.MONDAY_API_TOKEN = "monday-test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

describe("module contract", () => {
  test('import "server-only" is the first line', () => {
    const firstLine = readFileSync(SRC, "utf8").split("\n")[0];
    expect(firstLine).toBe('import "server-only";');
  });
});

describe("isMondayConfigured", () => {
  test("false when MONDAY_API_TOKEN is unset", () => {
    delete process.env.MONDAY_API_TOKEN;
    expect(isMondayConfigured()).toBe(false);
  });

  test("false when MONDAY_API_TOKEN is empty", () => {
    process.env.MONDAY_API_TOKEN = "";
    expect(isMondayConfigured()).toBe(false);
  });

  test("true when MONDAY_API_TOKEN is set", () => {
    expect(isMondayConfigured()).toBe(true);
  });
});

describe("mondayGraphQL request shape", () => {
  test("POSTs the GraphQL document to https://api.monday.com/v2 with bearer auth, API-Version 2024-01, JSON body, and a 15 s timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const mock = stubFetch(async () =>
      jsonResponse(200, { data: { boards: [] } }),
    );

    await mondayGraphQL("query { boards { id } }", { ids: ["123"] });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://api.monday.com/v2");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer monday-test-token");
    expect(headers.get("api-version")).toBe("2024-01");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "query { boards { id } }",
      variables: { ids: ["123"] },
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15000);
    expect(init?.signal).toBe(timeoutSpy.mock.results[0].value);
  });

  test("variables default to {} when omitted", async () => {
    const mock = stubFetch(async () => jsonResponse(200, { data: { ok: 1 } }));

    await mondayGraphQL("query { boards { id } }");

    const [, init] = mock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "query { boards { id } }",
      variables: {},
    });
  });

  test("resolves to the GraphQL data payload, typed", async () => {
    stubFetch(async () =>
      jsonResponse(200, { data: { boards: [{ id: "42", name: "Patients" }] } }),
    );

    const data = await mondayGraphQL<{
      boards: Array<{ id: string; name: string }>;
    }>("query { boards { id name } }");

    expect(data).toEqual({ boards: [{ id: "42", name: "Patients" }] });
  });
});

describe("mondayGraphQL unconfigured", () => {
  test("missing token → MondayConfigError without ever calling fetch", async () => {
    delete process.env.MONDAY_API_TOKEN;
    const mock = stubFetch(async () => jsonResponse(200, { data: {} }));

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      MondayConfigError,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  test("empty token → MondayConfigError naming the env var", async () => {
    process.env.MONDAY_API_TOKEN = "";
    stubFetch(async () => jsonResponse(200, { data: {} }));

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      /MONDAY_API_TOKEN/,
    );
  });
});

describe("mondayGraphQL error classification", () => {
  test.each([401, 403, 429, 500])(
    "HTTP %i → MondayApiError carrying the status",
    async (status) => {
      stubFetch(async () => new Response("denied", { status }));

      const err = await mondayGraphQL("query { boards { id } }").then(
        () => {
          throw new Error("expected mondayGraphQL to reject");
        },
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(MondayApiError);
      expect((err as MondayApiError).status).toBe(status);
      expect((err as MondayApiError).message).toContain(String(status));
    },
  );

  test("HTTP error message includes a response-body excerpt for debugging", async () => {
    stubFetch(async () => new Response("token scope missing", { status: 403 }));

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      /token scope missing/,
    );
  });

  test("a numeric Retry-After header rides the MondayApiError (the rate-limit 429 carries no body hint)", async () => {
    stubFetch(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
    );

    const err = await mondayGraphQL("query { boards { id } }").then(
      () => {
        throw new Error("expected mondayGraphQL to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as MondayApiError).retryAfterSeconds).toBe(60);
  });

  test("a missing or non-numeric Retry-After leaves retryAfterSeconds undefined", async () => {
    for (const headers of [
      undefined,
      { "Retry-After": "Wed, 12 Aug 2026 07:28:00 GMT" },
    ]) {
      stubFetch(async () => new Response("denied", { status: 429, headers }));
      const err = await mondayGraphQL("query { boards { id } }").then(
        () => {
          throw new Error("expected mondayGraphQL to reject");
        },
        (e: unknown) => e,
      );
      expect((err as MondayApiError).retryAfterSeconds).toBeUndefined();
    }
  });

  test("200 with a GraphQL errors[] array → MondayApiError with the first message and the errors attached", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        errors: [
          { message: "Board not accessible", extensions: { code: "X" } },
          { message: "second" },
        ],
      }),
    );

    const err = await mondayGraphQL("query { boards { id } }").then(
      () => {
        throw new Error("expected mondayGraphQL to reject");
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MondayApiError);
    expect((err as MondayApiError).message).toContain("Board not accessible");
    expect((err as MondayApiError).status).toBe(200);
    expect((err as MondayApiError).errors).toHaveLength(2);
  });

  test("200 with both data and errors[] still rejects (partial GraphQL results are not trusted)", async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        data: { boards: [] },
        errors: [{ message: "Complexity budget exhausted" }],
      }),
    );

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      MondayApiError,
    );
  });

  test("200 with a non-JSON body → MondayApiError, never a raw parse throw", async () => {
    stubFetch(async () => new Response("<html>gateway</html>", { status: 200 }));

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      MondayApiError,
    );
  });

  test("200 JSON without data or errors → MondayApiError (malformed GraphQL response)", async () => {
    stubFetch(async () => jsonResponse(200, { something: "else" }));

    await expect(mondayGraphQL("query { boards { id } }")).rejects.toThrow(
      MondayApiError,
    );
  });

  test("error classes are distinguishable by name for route mapping (config → 503)", async () => {
    delete process.env.MONDAY_API_TOKEN;
    const configErr = await mondayGraphQL("query { x }").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect((configErr as Error).name).toBe("MondayConfigError");

    process.env.MONDAY_API_TOKEN = "monday-test-token";
    stubFetch(async () => new Response("boom", { status: 500 }));
    const apiErr = await mondayGraphQL("query { x }").then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect((apiErr as Error).name).toBe("MondayApiError");
  });
});
