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
  getCampaign: vi.fn(),
  getCampaignCounts: vi.fn(),
  getCampaignRecipients: vi.fn(),
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
}));

vi.mock("@/lib/sms/repo", () => ({
  getCampaign: h.getCampaign,
  getCampaignCounts: h.getCampaignCounts,
  getCampaignRecipients: h.getCampaignRecipients,
  pauseCampaign: h.pauseCampaign,
  resumeCampaign: h.resumeCampaign,
  cancelCampaign: h.cancelCampaign,
}));

import { GET, PATCH } from "./route";

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

const ID = "11111111-2222-3333-4444-555555555555";

/** Next 15 route context: params is a Promise. */
function ctx(id: string = ID) {
  return { params: Promise.resolve({ id }) };
}

function getReq(headers?: HeadersInit) {
  return new Request(`http://x/api/campaigns/${ID}`, { headers });
}

function patchReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request(`http://x/api/campaigns/${ID}`, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/campaigns/[id]", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(401);
    expect(h.getCampaign).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await GET(getReq({ "x-amzn-oidc-data": viewersToken }), ctx());
    expect(res.status).toBe(403);
  });

  test("404 for an unknown campaign", async () => {
    h.getCampaign.mockResolvedValue(null);
    const res = await GET(getReq(marketingHeaders()), ctx());
    expect(res.status).toBe(404);
    expect(h.getCampaignRecipients).not.toHaveBeenCalled();
  });

  test("200 with campaign + counts + recipients", async () => {
    const campaign = { id: ID, status: "scheduled" };
    const counts = { pending: 3, sent: 1 };
    const recipients = [{ id: "r1" }, { id: "r2" }];
    h.getCampaign.mockResolvedValue(campaign);
    h.getCampaignCounts.mockResolvedValue(counts);
    h.getCampaignRecipients.mockResolvedValue(recipients);

    const res = await GET(getReq(marketingHeaders()), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ campaign, counts, recipients });
    expect(h.getCampaign).toHaveBeenCalledWith(ID);
    expect(h.getCampaignCounts).toHaveBeenCalledWith(ID);
    expect(h.getCampaignRecipients).toHaveBeenCalledWith(ID);
  });
});

describe("PATCH /api/campaigns/[id]", () => {
  test("401 when unauthenticated", async () => {
    const res = await PATCH(
      patchReq({ action: "pause" }, { "content-type": "application/json" }),
      ctx(),
    );
    expect(res.status).toBe(401);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON", async () => {
    const res = await PATCH(patchReq("{not json"), ctx());
    expect(res.status).toBe(400);
  });

  test("400 + issues on an unknown action", async () => {
    const res = await PATCH(patchReq({ action: "explode" }), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues).toBeDefined();
    expect(h.pauseCampaign).not.toHaveBeenCalled();
    expect(h.resumeCampaign).not.toHaveBeenCalled();
    expect(h.cancelCampaign).not.toHaveBeenCalled();
  });

  test.each([
    ["pause", h.pauseCampaign, "paused"],
    ["resume", h.resumeCampaign, "scheduled"],
    ["cancel", h.cancelCampaign, "canceled"],
  ] as const)(
    "%s → 200 with the fresh campaign row",
    async (action, mock, status) => {
      mock.mockResolvedValue({ id: ID, status });
      const res = await PATCH(patchReq({ action }), ctx());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.campaign).toEqual({ id: ID, status });
      expect(mock).toHaveBeenCalledWith(ID);
    },
  );

  test.each([
    ["pause", h.pauseCampaign],
    ["resume", h.resumeCampaign],
    ["cancel", h.cancelCampaign],
  ] as const)("%s → 409 when the transition guard loses", async (action, mock) => {
    mock.mockResolvedValue(null);
    const res = await PATCH(patchReq({ action }), ctx());
    expect(res.status).toBe(409);
  });
});
