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
