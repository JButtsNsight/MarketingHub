// @vitest-environment node
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

const h = vi.hoisted(() => ({
  gatewayFromEnv: vi.fn(),
  buildSchemaContext: vi.fn(),
  submitAssistant: vi.fn(),
}));

// Partial mock: env/config stubbed; GatewayError stays real (instanceof).
vi.mock("@/lib/gateway/hardening", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/gateway/hardening")>();
  return { ...actual, gatewayFromEnv: h.gatewayFromEnv };
});

// Partial mock: pg-meta introspection + gateway submit stubbed; the task-id
// regex and types stay real.
vi.mock("@/lib/console/assistant", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/console/assistant")>();
  return {
    ...actual,
    buildSchemaContext: h.buildSchemaContext,
    submitAssistant: h.submitAssistant,
  };
});

import { GatewayError, type GatewayConfig } from "@/lib/gateway/hardening";
import type { AssistantResult } from "@/lib/console/assistant";
import { POST } from "./route";

const TASK_ID = "mh-sqlast-123e4567-e89b-42d3-a456-426614174000";
const TASK_ID_2 = "mh-sqlast-00000000-0000-4000-8000-000000000000";

const GW: GatewayConfig = {
  baseUrl: "https://gw.example.com",
  apiKey: "sekrit-test-key",
  model: "claude-opus-4-8",
};

const CONTEXT = ["### marketinghub.contact_lists — rls on, ~12 rows"];

const RESULT: AssistantResult = {
  explanation: "Counts rows in contact_lists.",
  sql: "select count(*) from marketinghub.contact_lists;",
};

const DEGRADED = {
  answer: null,
  degraded: { reason: "assistant-unavailable" },
};

// The module-level answer store shared by the two routes lives on globalThis
// under this Symbol.for slot (route modules cannot export extra symbols).
const STORE_KEY = Symbol.for("marketinghub.console.assistant-answer-store");

interface TestStore {
  completed: Map<string, { result: AssistantResult; expiresAt: number }>;
  inFlight: Map<string, { taskId: string; expiresAt: number }>;
  submitBucket?: { tokens: number; lastRefillAt: number };
}

function store(): TestStore {
  const g = globalThis as unknown as Record<symbol, TestStore | undefined>;
  let s = g[STORE_KEY];
  if (!s) {
    s = { completed: new Map(), inFlight: new Map() };
    g[STORE_KEY] = s;
  }
  return s;
}

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["marketing"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.gatewayFromEnv.mockReset();
  h.buildSchemaContext.mockReset().mockResolvedValue(CONTEXT);
  h.submitAssistant.mockReset();
  Reflect.deleteProperty(globalThis, STORE_KEY);
});

afterEach(() => {
  clearAlbEnv();
});

function req(body: unknown, headers?: HeadersInit) {
  return new Request("http://x/api/console/assistant", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(headers ?? { "x-amzn-oidc-data": marketingToken }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/console/assistant", () => {
  test("401 when unauthenticated", async () => {
    const res = await POST(req({ question: "how many lists?" }, {}));
    expect(res.status).toBe(401);
    expect(h.buildSchemaContext).not.toHaveBeenCalled();
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      req({ question: "how many lists?" }, { "x-amzn-oidc-data": viewersToken }),
    );
    expect(res.status).toBe(403);
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("400 on a non-JSON body", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  test("400 when question is missing/blank/oversized", async () => {
    for (const body of [
      {},
      { question: "" },
      { question: "   " },
      { question: 42 },
      { question: "x".repeat(2001) },
    ]) {
      const res = await POST(req(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Validation failed");
    }
    expect(h.buildSchemaContext).not.toHaveBeenCalled();
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("gateway env absent → honest degraded, no pg-meta read, no submit", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    const res = await POST(req({ question: "how many lists?" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEGRADED);
    // No reason to introspect metadata we cannot send anywhere.
    expect(h.buildSchemaContext).not.toHaveBeenCalled();
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("submits the assistant task and returns a pending answer", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    const before = Date.now();
    const res = await POST(req({ question: "how many lists?" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      answer: { state: "pending", taskId: TASK_ID },
      degraded: null,
    });
    expect(h.submitAssistant).toHaveBeenCalledWith(
      GW,
      "how many lists?",
      CONTEXT,
    );
    // In-flight entry recorded under the question with the 5-min TTL.
    const entry = store().inFlight.get("how many lists?");
    expect(entry?.taskId).toBe(TASK_ID);
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(entry!.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  test("question is trimmed before keying/submitting", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    await POST(req({ question: "  how many lists?  " }));
    expect(h.submitAssistant).toHaveBeenCalledWith(
      GW,
      "how many lists?",
      CONTEXT,
    );
    expect(store().inFlight.has("how many lists?")).toBe(true);
  });

  test("identical question reuses the in-flight task (single submit)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    const first = await (await POST(req({ question: "q1" }))).json();
    const second = await (await POST(req({ question: "q1" }))).json();
    expect(first.answer).toEqual({ state: "pending", taskId: TASK_ID });
    expect(second.answer).toEqual({ state: "pending", taskId: TASK_ID });
    expect(h.submitAssistant).toHaveBeenCalledTimes(1);
  });

  test("a different question is a different key → separate submit", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant
      .mockResolvedValueOnce(TASK_ID)
      .mockResolvedValueOnce(TASK_ID_2);
    await POST(req({ question: "q1" }));
    const res = await POST(req({ question: "q2" }));
    expect((await res.json()).answer.taskId).toBe(TASK_ID_2);
    expect(h.submitAssistant).toHaveBeenCalledTimes(2);
  });

  test("an expired in-flight entry is pruned and resubmitted", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    store().inFlight.set("q1", {
      taskId: TASK_ID_2,
      expiresAt: Date.now() - 1,
    });
    const res = await POST(req({ question: "q1" }));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitAssistant).toHaveBeenCalledTimes(1);
  });

  test("completed-cache hit returns the answer without pg-meta or a submit", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    store().completed.set("q1", {
      result: RESULT,
      expiresAt: Date.now() + 60_000,
    });
    const res = await POST(req({ question: "q1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      answer: { state: "completed", ...RESULT },
      degraded: null,
    });
    expect(h.buildSchemaContext).not.toHaveBeenCalled();
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("an expired completed-cache entry is a miss (resubmits)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    store().completed.set("q1", {
      result: RESULT,
      expiresAt: Date.now() - 1,
    });
    const res = await POST(req({ question: "q1" }));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(store().completed.has("q1")).toBe(false);
    expect(h.submitAssistant).toHaveBeenCalledTimes(1);
  });

  test("in-flight map is bounded at 200 entries (oldest evicted)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    const s = store();
    for (let i = 0; i < 200; i += 1) {
      s.inFlight.set(`key${i}`, {
        taskId: TASK_ID_2,
        expiresAt: Date.now() + 60_000,
      });
    }
    await POST(req({ question: "q1" }));
    expect(s.inFlight.size).toBe(200);
    expect(s.inFlight.has("q1")).toBe(true);
    expect(s.inFlight.has("key0")).toBe(false);
    expect(s.inFlight.has("key1")).toBe(true);
  });

  test("submission budget exhausted → degraded, no pg-meta read, no submit", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    store().submitBucket = { tokens: 0, lastRefillAt: Date.now() };
    const res = await POST(req({ question: "q1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEGRADED);
    expect(h.buildSchemaContext).not.toHaveBeenCalled();
    expect(h.submitAssistant).not.toHaveBeenCalled();
    expect(store().inFlight.size).toBe(0);
  });

  test("submission budget refills over time (token bucket, 1 per 5 s)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockResolvedValue(TASK_ID);
    // Empty bucket, but one refill interval has elapsed → one token back.
    store().submitBucket = { tokens: 0, lastRefillAt: Date.now() - 5_100 };
    const res = await POST(req({ question: "q1" }));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitAssistant).toHaveBeenCalledTimes(1);
  });

  test("gateway submit failure → degraded with the fixed generic marker", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockRejectedValue(
      new GatewayError("gateway submit failed (HTTP 500)"),
    );
    const res = await POST(req({ question: "q1" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(DEGRADED);
    // Never the gateway URL, key, or HTTP internals.
    expect(JSON.stringify(json)).not.toMatch(/gw\.example|sekrit|HTTP/);
    // A failed submit leaves no in-flight entry behind.
    expect(store().inFlight.size).toBe(0);
  });

  test("pg-meta introspection failures propagate (not a gateway degradation)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.buildSchemaContext.mockRejectedValue(
      new Error("[console:pgmeta] list-tables failed: 500: boom"),
    );
    await expect(POST(req({ question: "q1" }))).rejects.toThrow(
      "[console:pgmeta]",
    );
    expect(h.submitAssistant).not.toHaveBeenCalled();
  });

  test("non-gateway submit errors propagate (no silent catch-all)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.submitAssistant.mockRejectedValue(new Error("boom"));
    await expect(POST(req({ question: "q1" }))).rejects.toThrow("boom");
  });
});
