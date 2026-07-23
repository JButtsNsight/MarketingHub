// @vitest-environment node
// The SimpleTexting client is server-only fetch code destined for the
// dispatcher worker; node env exercises the real undici Response/AbortSignal
// implementations the worker will see (no jsdom fetch shims).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isSimpleTextingConfigured, sendSms } from "./client";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/simpletexting/client.ts");

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

/** Node system error shape: an Error carrying a string `code`. */
function codedError(code: string, message = `request failed: ${code}`): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

beforeEach(() => {
  process.env.SIMPLETEXTING_API_TOKEN = "st-test-token";
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

describe("module contract", () => {
  test("import \"server-only\" is the first line", () => {
    const firstLine = readFileSync(SRC, "utf8").split("\n")[0];
    expect(firstLine).toBe('import "server-only";');
  });
});

describe("isSimpleTextingConfigured", () => {
  test("false when SIMPLETEXTING_API_TOKEN is unset", () => {
    delete process.env.SIMPLETEXTING_API_TOKEN;
    expect(isSimpleTextingConfigured()).toBe(false);
  });

  test("false when SIMPLETEXTING_API_TOKEN is empty", () => {
    process.env.SIMPLETEXTING_API_TOKEN = "";
    expect(isSimpleTextingConfigured()).toBe(false);
  });

  test("true when SIMPLETEXTING_API_TOKEN is set", () => {
    expect(isSimpleTextingConfigured()).toBe(true);
  });
});

describe("sendSms request shape", () => {
  test("POSTs the exact full URL with bearer auth, JSON payload, and a 15 s timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const mock = stubFetch(async () => jsonResponse(201, { id: "m1" }));

    await sendSms({ phone: "+15551230001", text: "Hello there" });

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    // Assert the full joined URL — a bad base+path join is an easy bug.
    expect(url).toBe("https://api-app2.simpletexting.com/v2/api/messages");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer st-test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      contactPhone: "+15551230001",
      text: "Hello there",
      mode: "AUTO",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15000);
    expect(init?.signal).toBe(timeoutSpy.mock.results[0].value);
  });

  test("includes accountPhone only when SIMPLETEXTING_ACCOUNT_PHONE is set", async () => {
    process.env.SIMPLETEXTING_ACCOUNT_PHONE = "5550009999";
    const mock = stubFetch(async () => jsonResponse(201, { id: "m1" }));

    await sendSms({ phone: "+15551230001", text: "Hi" });

    const [, init] = mock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      contactPhone: "+15551230001",
      text: "Hi",
      mode: "AUTO",
      accountPhone: "5550009999",
    });
  });
});

describe("sendSms → sent", () => {
  test("201 → sent with the SimpleTexting message id and credits", async () => {
    stubFetch(async () => jsonResponse(201, { id: "st-msg-42", credits: 2 }));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toEqual({ kind: "sent", id: "st-msg-42", credits: 2 });
  });

  test("201 with a non-JSON body is still sent (tolerant parse, null id/credits)", async () => {
    stubFetch(async () => new Response("created", { status: 201 }));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toEqual({ kind: "sent", id: null, credits: null });
  });
});

describe("sendSms HTTP status classification", () => {
  test.each([400, 404, 422])(
    "%i → permanent (definitive rejection, do not retry)",
    async (status) => {
      stubFetch(async () => new Response("nope", { status }));
      const result = await sendSms({ phone: "+15551230001", text: "Hi" });
      expect(result).toMatchObject({ kind: "permanent", status });
    },
  );

  test.each([401, 403])(
    "%i → config (bad token must not burn recipients to failed)",
    async (status) => {
      stubFetch(async () => new Response("denied", { status }));
      const result = await sendSms({ phone: "+15551230001", text: "Hi" });
      expect(result).toMatchObject({ kind: "config", status });
    },
  );

  test.each([429, 502, 503, 504])(
    "%i → retryable (transient, provably not processed)",
    async (status) => {
      stubFetch(async () => new Response("busy", { status }));
      const result = await sendSms({ phone: "+15551230001", text: "Hi" });
      expect(result).toMatchObject({ kind: "retryable", status });
    },
  );

  test("500 → ambiguous (the request may have been processed)", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({ kind: "ambiguous", status: 500 });
  });

  test("detail carries the HTTP status and a response-body excerpt for the audit trail", async () => {
    stubFetch(
      async () => new Response("invalid contactPhone", { status: 400 }),
    );
    const result = await sendSms({ phone: "not-a-phone", text: "Hi" });
    expect(result).toMatchObject({
      kind: "permanent",
      status: 400,
      detail: expect.stringContaining("400"),
    });
    expect(result).toMatchObject({
      detail: expect.stringContaining("invalid contactPhone"),
    });
  });

  test("detail is truncated so last_error stays an audit field, not a log sink", async () => {
    stubFetch(async () => new Response("x".repeat(5000), { status: 400 }));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    if (result.kind === "sent") throw new Error("expected a failure result");
    expect(result.detail.length).toBeLessThanOrEqual(400);
  });
});

describe("sendSms fetch-rejection classification", () => {
  test.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
    "%s → retryable (connection never established)",
    async (code) => {
      stubFetch(() => Promise.reject(codedError(code)));
      const result = await sendSms({ phone: "+15551230001", text: "Hi" });
      expect(result).toMatchObject({
        kind: "retryable",
        status: null,
        detail: expect.stringContaining(code),
      });
    },
  );

  test("undici-style TypeError('fetch failed') with the coded error on cause → retryable", async () => {
    stubFetch(() =>
      Promise.reject(
        new TypeError("fetch failed", { cause: codedError("ECONNREFUSED") }),
      ),
    );
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({
      kind: "retryable",
      status: null,
      detail: expect.stringContaining("ECONNREFUSED"),
    });
  });

  test("AbortError (AbortSignal.timeout fired) → ambiguous, never auto-retried", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    stubFetch(() => Promise.reject(abort));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({ kind: "ambiguous", status: null });
  });

  test("TimeoutError DOMException (Node's AbortSignal.timeout reason) → ambiguous", async () => {
    stubFetch(() =>
      Promise.reject(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    );
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({ kind: "ambiguous", status: null });
  });

  test("ECONNRESET → ambiguous (dropped mid-request; may have been processed)", async () => {
    stubFetch(() => Promise.reject(codedError("ECONNRESET")));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({
      kind: "ambiguous",
      status: null,
      detail: expect.stringContaining("ECONNRESET"),
    });
  });

  test("never throws: even a non-Error rejection resolves to ambiguous", async () => {
    stubFetch(() => Promise.reject("wires crossed"));
    await expect(
      sendSms({ phone: "+15551230001", text: "Hi" }),
    ).resolves.toMatchObject({
      kind: "ambiguous",
      status: null,
      detail: expect.stringContaining("wires crossed"),
    });
  });
});

describe("sendSms unconfigured", () => {
  test("missing token → config result without ever calling fetch", async () => {
    delete process.env.SIMPLETEXTING_API_TOKEN;
    const mock = stubFetch(async () => jsonResponse(201, { id: "m1" }));
    const result = await sendSms({ phone: "+15551230001", text: "Hi" });
    expect(result).toMatchObject({
      kind: "config",
      status: null,
      detail: expect.stringContaining("SIMPLETEXTING_API_TOKEN"),
    });
    expect(mock).not.toHaveBeenCalled();
  });
});
