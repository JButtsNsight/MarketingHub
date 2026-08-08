// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
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

// Mock the server-only repo; the route is the unit under test.
const h = vi.hoisted(() => ({
  listSuppressions: vi.fn(),
  addManualSuppression: vi.fn(),
}));

// Sentinel client threaded by the route into every repo call (Wave 4).
const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/sms/repo", () => ({
  listSuppressions: h.listSuppressions,
  addManualSuppression: h.addManualSuppression,
}));
vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
}));

import { GET, POST } from "./route";

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
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
  for (const fn of Object.values(h)) fn.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  };
}

function getReq(qs = "", headers: HeadersInit = marketingHeaders()) {
  return new Request(`http://x/api/suppressions${qs}`, { headers });
}

function postReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/suppressions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SUPPRESSION = {
  phone_e164: "+15550000006",
  reason: "manual",
  raw: { added_by: "amy@nsight.example", note: null },
  created_at: "2026-08-05T12:00:00Z",
};

describe("GET /api/suppressions", () => {
  test("401 when unauthenticated / 403 outside the marketing group", async () => {
    expect((await GET(getReq("", {}))).status).toBe(401);
    expect(
      (await GET(getReq("", { "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listSuppressions).not.toHaveBeenCalled();
  });

  test("lists without a filter when q is absent", async () => {
    h.listSuppressions.mockResolvedValue([SUPPRESSION]);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suppressions: [SUPPRESSION] });
    expect(h.listSuppressions).toHaveBeenCalledWith({}, userDb);
  });

  test("passes q through as the search query", async () => {
    h.listSuppressions.mockResolvedValue([]);
    const res = await GET(getReq("?q=555"));
    expect(res.status).toBe(200);
    expect(h.listSuppressions).toHaveBeenCalledWith(
      { query: "555" },
      userDb,
    );
  });
});

describe("POST /api/suppressions", () => {
  test("401/403 before any repo call", async () => {
    expect((await POST(postReq({ phone: "5555550100" }, {}))).status).toBe(401);
    expect(
      (
        await POST(
          postReq(
            { phone: "5555550100" },
            {
              "x-amzn-oidc-data": viewersToken,
              "content-type": "application/json",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(h.addManualSuppression).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON and on a missing phone", async () => {
    expect((await POST(postReq("{not json"))).status).toBe(400);
    expect((await POST(postReq({ note: "no phone" }))).status).toBe(400);
    expect(h.addManualSuppression).not.toHaveBeenCalled();
  });

  test("400 when the phone is not a usable US number", async () => {
    const res = await POST(postReq({ phone: "123" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/US phone/i);
    expect(h.addManualSuppression).not.toHaveBeenCalled();
  });

  test("201 on a new manual suppression, phone normalized to E.164", async () => {
    h.addManualSuppression.mockResolvedValue({
      created: true,
      suppression: SUPPRESSION,
    });
    const res = await POST(
      postReq({ phone: "(555) 000-0006", note: "asked by phone" }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ suppression: SUPPRESSION });
    expect(h.addManualSuppression).toHaveBeenCalledWith(
      "+15550000006",
      "amy@nsight.example",
      "asked by phone",
      userDb,
    );
  });

  test("409 when the phone is already suppressed", async () => {
    h.addManualSuppression.mockResolvedValue({
      created: false,
      suppression: { ...SUPPRESSION, reason: "stop" },
    });
    const res = await POST(postReq({ phone: "5550000006" }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already suppressed/i);
  });
});
