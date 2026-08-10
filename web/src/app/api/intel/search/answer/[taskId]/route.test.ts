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
  pollSynthesis: vi.fn(),
}));

// Partial mock: gateway calls stubbed; GatewayError stays real (instanceof).
vi.mock("@/lib/intel/gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/gateway")>();
  return {
    ...actual,
    gatewayFromEnv: h.gatewayFromEnv,
    pollSynthesis: h.pollSynthesis,
  };
});

import { GatewayError, type GatewayConfig } from "@/lib/intel/gateway";
import type { SynthesisResult } from "@/lib/intel/schema";
import { GET } from "./route";

const TASK_ID = "mh-intel-123e4567-e89b-42d3-a456-426614174000";

const GW: GatewayConfig = {
  baseUrl: "https://gw.example.com",
  apiKey: "sekrit-test-key",
  model: "claude-opus-4-8",
};

const RESULT: SynthesisResult = {
  answer: "Acme charges $99 [1].",
  citations: [1],
  ranking: [1],
};

// The module-level answer store shared by the two routes lives on globalThis
// under this Symbol.for slot (route modules cannot export extra symbols).
const STORE_KEY = Symbol.for("marketinghub.intel.search-answer-store");

interface TestStore {
  completed: Map<string, { result: SynthesisResult; expiresAt: number }>;
  inFlight: Map<string, { taskId: string; expiresAt: number }>;
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
  h.pollSynthesis.mockReset();
  Reflect.deleteProperty(globalThis, STORE_KEY);
});

afterEach(() => {
  clearAlbEnv();
});

function req(taskId: string, headers?: HeadersInit) {
  return new Request(`http://x/api/intel/search/answer/${taskId}`, {
    headers: headers ?? { "x-amzn-oidc-data": marketingToken },
  });
}

function params(taskId: string) {
  return { params: Promise.resolve({ taskId }) };
}

describe("GET /api/intel/search/answer/[taskId]", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req(TASK_ID, {}), params(TASK_ID));
    expect(res.status).toBe(401);
    expect(h.pollSynthesis).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await GET(
      req(TASK_ID, { "x-amzn-oidc-data": viewersToken }),
      params(TASK_ID),
    );
    expect(res.status).toBe(403);
    expect(h.pollSynthesis).not.toHaveBeenCalled();
  });

  test("400 invalid-task-id outside the mh-intel namespace (oracle guard)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    const foreign = [
      "nope",
      // Bare UUID without our namespace prefix.
      "123e4567-e89b-42d3-a456-426614174000",
      // Uppercase hex is rejected (we only ever mint lowercase UUIDs).
      "mh-intel-123E4567-E89B-42D3-A456-426614174000",
      // Truncated / malformed UUID payloads.
      "mh-intel-123",
      "mh-intel-123e4567-e89b-42d3-a456-426614174000-extra",
      // Another ClaudeCloud client's plausible task id.
      "socrates-task-42",
    ];
    for (const taskId of foreign) {
      const res = await GET(req(taskId), params(taskId));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid-task-id");
    }
    expect(h.pollSynthesis).not.toHaveBeenCalled();
  });

  test("gateway env absent → 200 failed/gateway-not-configured, no poll", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "failed",
      reason: "gateway-not-configured",
    });
    expect(h.pollSynthesis).not.toHaveBeenCalled();
  });

  test("relays pending as-is", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockResolvedValue({ state: "pending" });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "pending" });
    expect(h.pollSynthesis).toHaveBeenCalledWith(GW, TASK_ID);
    // Pending never touches the in-flight map or the cache.
    expect(store().completed.size).toBe(0);
  });

  test("completed: relays the answer and back-fills the completed-cache", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockResolvedValue({ state: "completed", ...RESULT });
    store().inFlight.set("acme||16", {
      taskId: TASK_ID,
      expiresAt: Date.now() + 60_000,
    });
    const before = Date.now();
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "completed", ...RESULT });
    // In-flight entry consumed; completed cached under the originating key
    // with the 10-min TTL.
    expect(store().inFlight.size).toBe(0);
    const cached = store().completed.get("acme||16");
    expect(cached?.result).toEqual(RESULT);
    expect(cached!.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(cached!.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });

  test("completed without an in-flight reverse mapping: relayed, not cached", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockResolvedValue({ state: "completed", ...RESULT });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "completed", ...RESULT });
    expect(store().completed.size).toBe(0);
  });

  test("completed-cache is bounded at 50 entries (oldest evicted)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockResolvedValue({ state: "completed", ...RESULT });
    const s = store();
    for (let i = 0; i < 50; i += 1) {
      s.completed.set(`key${i}`, {
        result: RESULT,
        expiresAt: Date.now() + 60_000,
      });
    }
    s.inFlight.set("acme||16", {
      taskId: TASK_ID,
      expiresAt: Date.now() + 60_000,
    });
    await GET(req(TASK_ID), params(TASK_ID));
    expect(s.completed.size).toBe(50);
    expect(s.completed.has("acme||16")).toBe(true);
    expect(s.completed.has("key0")).toBe(false);
    expect(s.completed.has("key1")).toBe(true);
  });

  test("failed: relays the failure, drops the in-flight entry, caches nothing", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockResolvedValue({
      state: "failed",
      reason: "synthesis-unparseable",
    });
    store().inFlight.set("acme||16", {
      taskId: TASK_ID,
      expiresAt: Date.now() + 60_000,
    });
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "failed",
      reason: "synthesis-unparseable",
    });
    expect(store().inFlight.size).toBe(0);
    expect(store().completed.size).toBe(0);
  });

  test("502 gateway-error on GatewayError (retryable to the browser)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockRejectedValue(
      new GatewayError("gateway poll failed (HTTP 500)"),
    );
    const res = await GET(req(TASK_ID), params(TASK_ID));
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toEqual({ error: "gateway-error" });
  });

  test("non-gateway poll errors propagate (no silent catch-all)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.pollSynthesis.mockRejectedValue(new Error("boom"));
    await expect(GET(req(TASK_ID), params(TASK_ID))).rejects.toThrow("boom");
  });
});
