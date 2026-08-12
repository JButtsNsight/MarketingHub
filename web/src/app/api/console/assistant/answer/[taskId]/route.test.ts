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
  pollAssistant: vi.fn(),
}));

// Partial mock: env/config stubbed; GatewayError stays real (instanceof).
vi.mock("@/lib/gateway/hardening", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/gateway/hardening")>();
  return { ...actual, gatewayFromEnv: h.gatewayFromEnv };
});

// Partial mock: the gateway poll stubbed; ASSISTANT_TASK_ID_RE stays real so
// the oracle guard under test is the shipped regex.
vi.mock("@/lib/console/assistant", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/console/assistant")>();
  return { ...actual, pollAssistant: h.pollAssistant };
});

import { GatewayError, type GatewayConfig } from "@/lib/gateway/hardening";
import type { AssistantResult } from "@/lib/console/assistant";
import { GET } from "./route";

const TASK_ID = "mh-sqlast-123e4567-e89b-42d3-a456-426614174000";

const GW: GatewayConfig = {
  baseUrl: "https://gw.example.com",
  apiKey: "sekrit-test-key",
  model: "claude-opus-4-8",
};

const RESULT: AssistantResult = {
  explanation: "Counts rows in contact_lists.",
  sql: "select count(*) from marketinghub.contact_lists;",
};

// The module-level answer store shared by the two routes lives on globalThis
// under this Symbol.for slot (route modules cannot export extra symbols).
const STORE_KEY = Symbol.for("marketinghub.console.assistant-answer-store");

interface TestStore {
  completed: Map<string, { result: AssistantResult; expiresAt: number }>;
  inFlight: Map<string, { taskId: string; expiresAt: number }>;
  pollBucket?: { tokens: number; lastRefillAt: number };
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

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["mh-section-platform"],
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
  h.pollAssistant.mockReset();
  Reflect.deleteProperty(globalThis, STORE_KEY);
});

afterEach(() => {
  clearAlbEnv();
});

function req(taskId: string, headers?: HeadersInit) {
  return new Request(`http://x/api/console/assistant/answer/${taskId}`, {
    headers: headers ?? { "x-amzn-oidc-data": platformToken },
  });
}

function params(taskId: string) {
  return { params: Promise.resolve({ taskId }) };
}

describe("GET /api/console/assistant/answer/[taskId]", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req(TASK_ID, {}), params(TASK_ID));
    expect(res.status).toBe(401);
    expect(h.pollAssistant).not.toHaveBeenCalled();
  });

  test("403 when missing the platform section", async () => {
    const res = await GET(
      req(TASK_ID, { "x-amzn-oidc-data": viewersToken }),
      params(TASK_ID),
    );
    expect(res.status).toBe(403);
    expect(h.pollAssistant).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const res = await GET(
      req(TASK_ID, { "x-amzn-oidc-data": marketingToken }),
      params(TASK_ID),
    );
    expect(res.status).toBe(403);
    expect(h.pollAssistant).not.toHaveBeenCalled();

    h.gatewayFromEnv.mockReturnValue(null); // degraded body; the gate is the point
    const admin = await GET(
      req(TASK_ID, { "x-amzn-oidc-data": adminToken }),
      params(TASK_ID),
    );
    expect(admin.status).toBe(200);
  });

  test("404 invalid-task-id outside the mh-sqlast namespace (oracle guard)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    const foreign = [
      "nope",
      // Bare UUID without our namespace prefix.
      "123e4567-e89b-42d3-a456-426614174000",
      // Our OWN intel namespace is foreign to this relay.
      "mh-intel-123e4567-e89b-42d3-a456-426614174000",
      // Uppercase hex is rejected (we only ever mint lowercase UUIDs).
      "mh-sqlast-123E4567-E89B-42D3-A456-426614174000",
      // Truncated / malformed UUID payloads.
      "mh-sqlast-123",
      "mh-sqlast-123e4567-e89b-42d3-a456-426614174000-extra",
      // Another ClaudeCloud client's plausible task id.
      "socrates-task-42",
    ];
    for (const taskId of foreign) {
      const res = await GET(req(taskId), params(taskId));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("invalid-task-id");
    }
    expect(h.pollAssistant).not.toHaveBeenCalled();
  });

  test("gateway env absent → 200 failed/gateway-not-configured, no poll", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "failed",
      reason: "gateway-not-configured",
    });
    expect(h.pollAssistant).not.toHaveBeenCalled();
  });

  test("relays pending as-is", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "pending" });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" });
    expect(h.pollAssistant).toHaveBeenCalledWith(GW, TASK_ID);
    // Pending never touches the in-flight map or the cache.
    expect(store().completed.size).toBe(0);
  });

  test("completed: relays the answer and back-fills the completed-cache", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "completed", ...RESULT });
    store().inFlight.set("how many lists?", {
      taskId: TASK_ID,
      expiresAt: Date.now() + 60_000,
    });
    const before = Date.now();
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "completed", ...RESULT });
    // In-flight entry consumed; completed cached under the originating
    // question with the 10-min TTL.
    expect(store().inFlight.size).toBe(0);
    const cached = store().completed.get("how many lists?");
    expect(cached?.result).toEqual(RESULT);
    expect(cached!.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(cached!.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  test("completed without an in-flight reverse mapping: relayed, not cached", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "completed", ...RESULT });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "completed", ...RESULT });
    expect(store().completed.size).toBe(0);
  });

  test("completed-cache is bounded at 50 entries (oldest evicted)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "completed", ...RESULT });
    const s = store();
    for (let i = 0; i < 50; i += 1) {
      s.completed.set(`key${i}`, {
        result: RESULT,
        expiresAt: Date.now() + 60_000,
      });
    }
    s.inFlight.set("q1", { taskId: TASK_ID, expiresAt: Date.now() + 60_000 });
    await GET(req(TASK_ID), params(TASK_ID));
    expect(s.completed.size).toBe(50);
    expect(s.completed.has("q1")).toBe(true);
    expect(s.completed.has("key0")).toBe(false);
    expect(s.completed.has("key1")).toBe(true);
  });

  test("failed: relays the failure, drops the in-flight entry, caches nothing", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({
      state: "failed",
      reason: "assistant-unparseable",
    });
    store().inFlight.set("q1", {
      taskId: TASK_ID,
      expiresAt: Date.now() + 60_000,
    });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "failed",
      reason: "assistant-unparseable",
    });
    expect(store().inFlight.size).toBe(0);
    expect(store().completed.size).toBe(0);
  });

  test("poll budget: fresh bucket starts at a 30-poll burst; exhaustion answers 429 with no gateway poll", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "pending" });
    // First relay lazily initializes the burst and spends one token.
    expect((await GET(req(TASK_ID), params(TASK_ID))).status).toBe(200);
    expect(store().pollBucket?.tokens).toBe(29);
    // Deterministic exhaustion (a future lastRefillAt disables refill drift).
    store().pollBucket = { tokens: 0.5, lastRefillAt: Date.now() + 60_000 };
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate-limited" });
    // The brake is the point: an over-budget poll never reaches the gateway.
    expect(h.pollAssistant).toHaveBeenCalledTimes(1);
  });

  test("poll budget refills over time (one token per 500 ms)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockResolvedValue({ state: "pending" });
    store().pollBucket = { tokens: 0, lastRefillAt: Date.now() - 600 };
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(h.pollAssistant).toHaveBeenCalledTimes(1);
  });

  test("auth/namespace/env guards run before the poll budget (no token spent)", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    store().pollBucket = { tokens: 0, lastRefillAt: Date.now() };
    // Unauthenticated, foreign id, and env-absent all bypass the bucket —
    // none of them would have cost a gateway round trip.
    expect((await GET(req(TASK_ID, {}), params(TASK_ID))).status).toBe(401);
    expect((await GET(req("nope"), params("nope"))).status).toBe(404);
    expect((await GET(req(TASK_ID), params(TASK_ID))).status).toBe(200);
    expect(store().pollBucket?.tokens).toBe(0);
  });

  test("502 gateway-error on GatewayError (retryable to the browser)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockRejectedValue(
      new GatewayError("gateway poll failed (HTTP 500)"),
    );
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "gateway-error" });
  });

  test("non-gateway poll errors propagate (no silent catch-all)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollAssistant.mockRejectedValue(new Error("boom"));
    await expect(GET(req(TASK_ID), params(TASK_ID))).rejects.toThrow("boom");
  });
});
