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
  searchChunksFts: vi.fn(),
  gatewayFromEnv: vi.fn(),
  submitSynthesis: vi.fn(),
}));

const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
  getServiceClient: () => {
    throw new Error("routes must use the user client, not the service client");
  },
}));

// Partial mock: searchChunksFts stubbed; NotProvisionedError stays real so
// the route's instanceof mapping is what's under test.
vi.mock("@/lib/intel/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/repo")>();
  return { ...actual, searchChunksFts: h.searchChunksFts };
});

// Partial mock: gateway calls stubbed; GatewayError stays real (instanceof).
vi.mock("@/lib/intel/gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/gateway")>();
  return {
    ...actual,
    gatewayFromEnv: h.gatewayFromEnv,
    submitSynthesis: h.submitSynthesis,
  };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { GatewayError, type GatewayConfig } from "@/lib/intel/gateway";
import type { FtsChunkRow, SynthesisResult } from "@/lib/intel/schema";
import { GET } from "./route";

const SOURCE_ID = "5f5e8c2a-9d1b-4f3a-8a51-51e6dd2e1a01";
const TASK_ID = "mh-intel-123e4567-e89b-42d3-a456-426614174000";

const GW: GatewayConfig = {
  baseUrl: "https://gw.example.com",
  apiKey: "sekrit-test-key",
  model: "claude-opus-4-8",
};

const ROWS: FtsChunkRow[] = [
  {
    chunk_id: 7,
    document_id: "9a1b2c3d-0000-4111-8222-333344445555",
    source_id: SOURCE_ID,
    seq: 0,
    content: "Acme charges $99.",
    rank: 0.42,
    document_title: "Pricing page",
    source_name: "Acme Corp",
  },
];

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

let intelToken: string;
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
  intelToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["mh-section-intel"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.searchChunksFts.mockReset();
  h.gatewayFromEnv.mockReset();
  h.submitSynthesis.mockReset();
  Reflect.deleteProperty(globalThis, STORE_KEY);
});

afterEach(() => {
  clearAlbEnv();
});

function req(query: string, headers?: HeadersInit) {
  return new Request(`http://x/api/intel/search${query}`, {
    headers: headers ?? { "x-amzn-oidc-data": intelToken },
  });
}

describe("GET /api/intel/search", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req("?q=acme", {}));
    expect(res.status).toBe(401);
    expect(h.searchChunksFts).not.toHaveBeenCalled();
  });

  test("403 when missing the intel section", async () => {
    const res = await GET(req("?q=acme", { "x-amzn-oidc-data": viewersToken }));
    expect(res.status).toBe(403);
    expect(h.searchChunksFts).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await GET(
      req("?q=acme", { "x-amzn-oidc-data": marketingToken }),
    );
    expect(forbidden.status).toBe(403);
    expect(h.searchChunksFts).not.toHaveBeenCalled();

    h.gatewayFromEnv.mockReturnValue(null); // keyword-only degrade; the gate is the point
    h.searchChunksFts.mockResolvedValue([]);
    const admin = await GET(req("?q=acme", { "x-amzn-oidc-data": adminToken }));
    expect(admin.status).toBe(200);
  });

  test("400 when q is missing/blank", async () => {
    for (const qs of ["", "?q=", "?q=%20%20"]) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Validation failed");
    }
    expect(h.searchChunksFts).not.toHaveBeenCalled();
  });

  test("400 when count is out of range or not an integer", async () => {
    for (const count of ["0", "51", "2.5", "abc"]) {
      const res = await GET(req(`?q=acme&count=${count}`));
      expect(res.status).toBe(400);
    }
    expect(h.searchChunksFts).not.toHaveBeenCalled();
  });

  test("400 when sourceId is not a UUID", async () => {
    const res = await GET(req("?q=acme&sourceId=nope"));
    expect(res.status).toBe(400);
    expect(h.searchChunksFts).not.toHaveBeenCalled();
  });

  test("503 intel-not-provisioned when the substrate is absent", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockRejectedValue(
      new NotProvisionedError("search", "PGRST202"),
    );
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("intel-not-provisioned");
  });

  test("keyword-only when the gateway env is absent (no gateway call)", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockResolvedValue(ROWS);
    const res = await GET(req("?q=acme%20pricing"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "acme pricing",
      mode: "keyword-only",
      results: ROWS,
      answer: null,
      degraded: { reason: "gateway-not-configured" },
    });
    // New default count is 16 (one list serves display + synthesis).
    expect(h.searchChunksFts).toHaveBeenCalledWith(
      "acme pricing",
      { sourceId: null, count: 16 },
      userDb,
    );
    expect(h.submitSynthesis).not.toHaveBeenCalled();
  });

  test("threads sourceId filter and count through to the repo", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockResolvedValue([]);
    const res = await GET(req(`?q=acme&sourceId=${SOURCE_ID}&count=20`));
    expect(res.status).toBe(200);
    expect(h.searchChunksFts).toHaveBeenCalledWith(
      "acme",
      { sourceId: SOURCE_ID, count: 20 },
      userDb,
    );
  });

  test("zero rows with gateway configured: agentic, no answer, NO gateway call", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue([]);
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "acme",
      mode: "agentic",
      results: [],
      answer: null,
      degraded: null,
    });
    expect(h.submitSynthesis).not.toHaveBeenCalled();
  });

  test("OR fallback: AND-miss retries once with OR and serves the hits", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockResolvedValueOnce([]).mockResolvedValueOnce(ROWS);
    const res = await GET(req("?q=podcast%20pricing"));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual(ROWS);
    expect(h.searchChunksFts).toHaveBeenCalledTimes(2);
    expect(h.searchChunksFts).toHaveBeenNthCalledWith(
      1,
      "podcast pricing",
      { sourceId: null, count: 16 },
      userDb,
    );
    expect(h.searchChunksFts).toHaveBeenNthCalledWith(
      2,
      "podcast OR pricing",
      { sourceId: null, count: 16 },
      userDb,
    );
  });

  test("OR fallback: zero rows on both passes stays a clean zero-result", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue([]);
    const res = await GET(req("?q=podcast%20pricing"));
    expect((await res.json()).results).toEqual([]);
    expect(h.searchChunksFts).toHaveBeenCalledTimes(2);
    expect(h.submitSynthesis).not.toHaveBeenCalled();
  });

  test.each([
    ["quoted phrase", '?q=%22acme%20pricing%22'],
    ["negation", "?q=acme%20-pricing"],
    ["explicit lowercase or", "?q=acme%20or%20pricing"],
    ["explicit uppercase OR", "?q=acme%20OR%20pricing"],
    ["single term", "?q=acme"],
  ])("OR fallback never loosens %s", async (_label, qs) => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockResolvedValue([]);
    const res = await GET(req(qs));
    expect(res.status).toBe(200);
    expect(h.searchChunksFts).toHaveBeenCalledTimes(1);
  });

  test("zero rows without gateway: keyword-only + degraded marker", async () => {
    h.gatewayFromEnv.mockReturnValue(null);
    h.searchChunksFts.mockResolvedValue([]);
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "acme",
      mode: "keyword-only",
      results: [],
      answer: null,
      degraded: { reason: "gateway-not-configured" },
    });
  });

  test("agentic: submits synthesis and returns a pending answer", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    const before = Date.now();
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "acme",
      mode: "agentic",
      results: ROWS,
      answer: { state: "pending", taskId: TASK_ID },
      degraded: null,
    });
    expect(h.submitSynthesis).toHaveBeenCalledWith(GW, "acme", ROWS);
    // In-flight entry recorded under `q|sourceId|count|chunkIds` (the
    // fingerprint binds the answer to the exact ordered candidate rows the
    // model will read) with the 5-min TTL.
    const entry = store().inFlight.get("acme||16|7");
    expect(entry?.taskId).toBe(TASK_ID);
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(entry!.expiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  test("agentic: identical query reuses the in-flight task (single submit)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    const first = await (await GET(req("?q=acme"))).json();
    const second = await (await GET(req("?q=acme"))).json();
    expect(first.answer).toEqual({ state: "pending", taskId: TASK_ID });
    expect(second.answer).toEqual({ state: "pending", taskId: TASK_ID });
    expect(h.submitSynthesis).toHaveBeenCalledTimes(1);
  });

  test("agentic: a different count is a different key → separate submit", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis
      .mockResolvedValueOnce(TASK_ID)
      .mockResolvedValueOnce("mh-intel-00000000-0000-4000-8000-000000000000");
    await GET(req("?q=acme"));
    const res = await GET(req("?q=acme&count=20"));
    expect((await res.json()).answer.taskId).toBe(
      "mh-intel-00000000-0000-4000-8000-000000000000",
    );
    expect(h.submitSynthesis).toHaveBeenCalledTimes(2);
  });

  test("agentic: an expired in-flight entry is pruned and resubmitted", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    store().inFlight.set("acme||16|7", {
      taskId: "mh-intel-00000000-0000-4000-8000-000000000000",
      expiresAt: Date.now() - 1,
    });
    const res = await GET(req("?q=acme"));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitSynthesis).toHaveBeenCalledTimes(1);
  });

  test("agentic: completed-cache hit returns the answer without a submit", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    store().completed.set("acme||16|7", {
      result: RESULT,
      expiresAt: Date.now() + 60_000,
    });
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "acme",
      mode: "agentic",
      results: ROWS,
      answer: { state: "completed", ...RESULT },
      degraded: null,
    });
    expect(h.submitSynthesis).not.toHaveBeenCalled();
  });

  test("agentic: an expired completed-cache entry is a miss (resubmits)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    store().completed.set("acme||16|7", {
      result: RESULT,
      expiresAt: Date.now() - 1,
    });
    const res = await GET(req("?q=acme"));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(store().completed.has("acme||16|7")).toBe(false);
    expect(h.submitSynthesis).toHaveBeenCalledTimes(1);
  });

  test("corpus drift busts the completed cache: cached citations never bind to fresh rows", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    // The cached answer was synthesized from chunk 7; the corpus changed and
    // the fresh retrieval returns chunk 8 — the fingerprinted key must MISS
    // (a positional citation from the old answer would otherwise be mapped
    // onto a row the model never read).
    const drifted = [{ ...ROWS[0], chunk_id: 8, document_title: "Just pasted" }];
    h.searchChunksFts.mockResolvedValue(drifted);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    store().completed.set("acme||16|7", {
      result: RESULT,
      expiresAt: Date.now() + 60_000,
    });
    const res = await GET(req("?q=acme"));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitSynthesis).toHaveBeenCalledWith(GW, "acme", drifted);
  });

  test("corpus drift busts in-flight reuse: a changed retrieval gets its own task", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    const drifted = [{ ...ROWS[0], chunk_id: 8 }];
    h.searchChunksFts.mockResolvedValue(drifted);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    store().inFlight.set("acme||16|7", {
      taskId: "mh-intel-00000000-0000-4000-8000-000000000000",
      expiresAt: Date.now() + 60_000,
    });
    const res = await GET(req("?q=acme"));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitSynthesis).toHaveBeenCalledTimes(1);
  });

  test("in-flight map is bounded at 200 entries (oldest evicted)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    const s = store();
    for (let i = 0; i < 200; i += 1) {
      s.inFlight.set(`key${i}`, {
        taskId: "mh-intel-00000000-0000-4000-8000-000000000000",
        expiresAt: Date.now() + 60_000,
      });
    }
    await GET(req("?q=acme"));
    expect(s.inFlight.size).toBe(200);
    expect(s.inFlight.has("acme||16|7")).toBe(true);
    expect(s.inFlight.has("key0")).toBe(false);
    expect(s.inFlight.has("key1")).toBe(true);
  });

  test("submission budget exhausted → keyword-only degrade, NO gateway call", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    store().submitBucket = { tokens: 0, lastRefillAt: Date.now() };
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("keyword-only");
    expect(json.results).toEqual(ROWS);
    expect(json.answer).toBeNull();
    expect(json.degraded.reason).toBe("synthesis-unavailable");
    expect(h.submitSynthesis).not.toHaveBeenCalled();
    expect(store().inFlight.size).toBe(0);
  });

  test("submission budget refills over time (token bucket)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockResolvedValue(TASK_ID);
    // Empty bucket, but one refill interval has elapsed → one token back.
    store().submitBucket = { tokens: 0, lastRefillAt: Date.now() - 2_100 };
    const res = await GET(req("?q=acme"));
    expect((await res.json()).answer).toEqual({
      state: "pending",
      taskId: TASK_ID,
    });
    expect(h.submitSynthesis).toHaveBeenCalledTimes(1);
  });

  test("gateway submit failure degrades to keyword-only with generic detail", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockRejectedValue(
      new GatewayError("gateway submit failed (HTTP 500)"),
    );
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("keyword-only");
    expect(json.results).toEqual(ROWS);
    expect(json.answer).toBeNull();
    expect(json.degraded.reason).toBe("synthesis-unavailable");
    // Detail must be generic — never the gateway URL, key, or HTTP internals.
    expect(typeof json.degraded.detail).toBe("string");
    expect(json.degraded.detail).not.toMatch(/gw\.example|sekrit|HTTP/);
    // A failed submit leaves no in-flight entry behind.
    expect(store().inFlight.size).toBe(0);
  });

  test("non-gateway submit errors propagate (no silent catch-all)", async () => {
    h.gatewayFromEnv.mockReturnValue(GW);
    h.searchChunksFts.mockResolvedValue(ROWS);
    h.submitSynthesis.mockRejectedValue(new Error("boom"));
    await expect(GET(req("?q=acme"))).rejects.toThrow("boom");
  });
});
