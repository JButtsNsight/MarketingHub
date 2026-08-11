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
  getPendingRecipientZones: vi.fn(),
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  rescheduleCampaign: vi.fn(),
}));

// Sentinel client threaded by the route into every repo call (Wave 4).
const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
}));

vi.mock("@/lib/sms/repo", () => ({
  getCampaign: h.getCampaign,
  getCampaignCounts: h.getCampaignCounts,
  getCampaignRecipients: h.getCampaignRecipients,
  getPendingRecipientZones: h.getPendingRecipientZones,
  pauseCampaign: h.pauseCampaign,
  resumeCampaign: h.resumeCampaign,
  cancelCampaign: h.cancelCampaign,
  rescheduleCampaign: h.rescheduleCampaign,
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
  // No pending zone groups unless a test says otherwise → the past-slot
  // check reduces to the fallback zone, exactly the pre-zones behavior.
  h.getPendingRecipientZones.mockResolvedValue([]);
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

  test("404 (not 500) for a non-UUID path id, before any repo call", async () => {
    const res = await GET(getReq(marketingHeaders()), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    // never reaches PostgREST — a raw non-UUID would 22P02 → thrown → 500
    expect(h.getCampaign).not.toHaveBeenCalled();
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
    expect(h.getCampaign).toHaveBeenCalledWith(ID, userDb);
    expect(h.getCampaignCounts).toHaveBeenCalledWith(ID, userDb);
    expect(h.getCampaignRecipients).toHaveBeenCalledWith(ID, userDb);
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

  test("404 (not 500) for a non-UUID path id, before any repo call", async () => {
    const res = await PATCH(patchReq({ action: "pause" }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
    expect(h.resumeCampaign).not.toHaveBeenCalled();
    expect(h.cancelCampaign).not.toHaveBeenCalled();
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
      expect(mock).toHaveBeenCalledWith(ID, userDb);
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

  const reschedule = {
    action: "reschedule",
    sendDate: "2999-01-04", // a Friday
    sendTime: "08:30",
    sendTimezone: "America/Los_Angeles",
  };

  test("reschedule → 200, passing the new slot to the repo", async () => {
    h.rescheduleCampaign.mockResolvedValue({ id: ID, status: "scheduled" });
    const res = await PATCH(patchReq(reschedule), ctx());
    expect(res.status).toBe(200);
    expect(h.rescheduleCampaign).toHaveBeenCalledWith(
      ID,
      {
        sendDate: "2999-01-04",
        sendTime: "08:30",
        sendTimezone: "America/Los_Angeles",
      },
      userDb,
    );
  });

  test("reschedule → 409 when the campaign already started sending", async () => {
    h.rescheduleCampaign.mockResolvedValue(null);
    const res = await PATCH(patchReq(reschedule), ctx());
    expect(res.status).toBe(409);
  });

  test("reschedule → 400 for a weekend date, before any repo call", async () => {
    const res = await PATCH(
      patchReq({ ...reschedule, sendDate: "2999-01-06" }), // a Sunday
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(h.rescheduleCampaign).not.toHaveBeenCalled();
  });

  test("reschedule → 400 for an off-grid time slot", async () => {
    const res = await PATCH(patchReq({ ...reschedule, sendTime: "14:00" }), ctx());
    expect(res.status).toBe(400);
    expect(h.rescheduleCampaign).not.toHaveBeenCalled();
  });

  test("reschedule → 400 when the slot is already in the past", async () => {
    const res = await PATCH(
      patchReq({ ...reschedule, sendDate: "2020-01-03" }), // a past Friday
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(h.rescheduleCampaign).not.toHaveBeenCalled();
  });
});

describe("PATCH reschedule — earliest-instant past-slot check", () => {
  // 2999-01-04 (a Friday) 08:30 = 13:30Z in ET (EST) but 18:30Z in HT; the
  // mocked "now" sits between the two instants.
  const betweenEtAndHt = Date.parse("2999-01-04T15:00:00Z");
  const slot = { action: "reschedule", sendDate: "2999-01-04", sendTime: "08:30" };
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  test("400 when a pending zone group is already past, even though the fallback zone is still ahead", async () => {
    h.getPendingRecipientZones.mockResolvedValue(["America/New_York"]);
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await PATCH(
      patchReq({ ...slot, sendTimezone: "Pacific/Honolulu" }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already in the past/i);
    expect(h.getPendingRecipientZones).toHaveBeenCalledWith(ID, userDb);
    expect(h.rescheduleCampaign).not.toHaveBeenCalled();
  });

  test("200 when the only pending zone group is still ahead — the fallback zone is not dragged in", async () => {
    h.getPendingRecipientZones.mockResolvedValue(["Pacific/Honolulu"]);
    h.rescheduleCampaign.mockResolvedValue({ id: ID, status: "scheduled" });
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await PATCH(
      patchReq({ ...slot, sendTimezone: "America/New_York" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(h.rescheduleCampaign).toHaveBeenCalledTimes(1);
  });

  test("null zone groups decode to the (new) fallback zone", async () => {
    h.getPendingRecipientZones.mockResolvedValue([null]);
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await PATCH(
      patchReq({ ...slot, sendTimezone: "America/New_York" }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(h.rescheduleCampaign).not.toHaveBeenCalled();
  });
});
