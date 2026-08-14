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
import { BisonApiError } from "@/lib/email/bison";

// Mock the server-only repo, the member loader, and the Bison transport; the
// route is the unit under test. BisonApiError stays real (instanceof).
const h = vi.hoisted(() => ({
  headerValue: null as string | null,
  getContactList: vi.fn(),
  loadPushableLeads: vi.fn(),
  readConnection: vi.fn(),
  pushLeads: vi.fn(),
}));

// The route reads identity via next/headers, not the Request object.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "x-amzn-oidc-data" ? h.headerValue : null,
    }),
}));

vi.mock("@/lib/contacts/repo", () => ({
  getContactList: h.getContactList,
}));

vi.mock("@/lib/email/pushList", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/pushList")>()),
  loadPushableLeads: h.loadPushableLeads,
}));

vi.mock("@/lib/email/bison", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/bison")>()),
  readConnection: h.readConnection,
  pushLeads: h.pushLeads,
}));

import { POST } from "./route";

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

const LIST_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const API_KEY = "9|abc";
const CONN = {
  baseUrl: "https://dedi.emailbison.com",
  apiKey: API_KEY,
  workspaceName: "Nsight",
};

const csvList = { id: LIST_ID, name: "August sheet", source: "csv" };
const mondayList = { id: LIST_ID, name: "Patient board", source: "monday" };

const LEADS = [
  { email: "ada@ex.com", firstName: "Ada", lastName: "Lovelace" },
  { email: "grace@navy.mil", firstName: "Grace" },
];

/** Wire the full happy path; tests override single mocks. */
function primeHappyPath() {
  h.readConnection.mockResolvedValue(CONN);
  h.getContactList.mockResolvedValue(csvList);
  h.loadPushableLeads.mockResolvedValue({
    leads: LEADS,
    skipped: 1,
    overCap: false,
  });
  h.pushLeads.mockResolvedValue({
    attached: 2,
    skipped: 0,
    message: "Leads attached",
  });
}

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.headerValue = marketingToken;
  for (const fn of [
    h.getContactList,
    h.loadPushableLeads,
    h.readConnection,
    h.pushLeads,
  ]) {
    fn.mockReset();
  }
  primeHappyPath();
});

afterEach(() => {
  clearAlbEnv();
});

function postReq(body: unknown = { contactListId: LIST_ID }) {
  return new Request("http://x/api/email/campaigns/7/push-list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(id = "7") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/email/campaigns/[id]/push-list", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    h.headerValue = null;
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(401);
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    h.headerValue = viewersToken;
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(403);
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("404 when the campaign path id is not an integer", async () => {
    const res = await POST(postReq(), ctx("abc"));
    expect(res.status).toBe(404);
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON and on a non-uuid contactListId", async () => {
    expect((await POST(postReq("{not json"), ctx())).status).toBe(400);
    expect(
      (await POST(postReq({ contactListId: "nope" }), ctx())).status,
    ).toBe(400);
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("409 when EmailBison is not connected", async () => {
    h.readConnection.mockResolvedValue(null);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("EmailBison is not connected");
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("502 when the connection secret read fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.readConnection.mockRejectedValue(new Error("secrets down"));
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toMatch(/could not read/i);
    errSpy.mockRestore();
  });

  test("404 when the list does not exist", async () => {
    h.getContactList.mockResolvedValue(null);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(404);
    expect(h.loadPushableLeads).not.toHaveBeenCalled();
  });

  test("422 for a Monday-backed list (stored members only this round)", async () => {
    h.getContactList.mockResolvedValue(mondayList);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("Monday-backed lists aren't supported yet");
    expect(h.loadPushableLeads).not.toHaveBeenCalled();
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("422 when no member has an email address", async () => {
    h.loadPushableLeads.mockResolvedValue({
      leads: [],
      skipped: 4,
      overCap: false,
    });
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("no members with an email address");
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("422 over the push cap — nothing is pushed", async () => {
    h.loadPushableLeads.mockResolvedValue({
      leads: LEADS,
      skipped: 0,
      overCap: true,
    });
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/10,000 usable emails/);
    expect(h.pushLeads).not.toHaveBeenCalled();
  });

  test("happy path: pushes the loaded leads, sums skipped, carries the sync note", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    // skipped = no-email members (1) + strict-format rejects upstream (0).
    expect(json).toEqual({
      attached: 2,
      skipped: 1,
      message: "Leads attached",
      note: "leads can take ~5 minutes to appear on active campaigns",
    });
    expect(h.pushLeads).toHaveBeenCalledWith(CONN, 7, LEADS);
    expect(h.loadPushableLeads).toHaveBeenCalledWith(LIST_ID);
    // The API key never reaches the response payload.
    expect(JSON.stringify(json)).not.toContain(API_KEY);
    // Audit line carries who pushed what where.
    const line = logSpy.mock.calls
      .map(([msg]) => String(msg))
      .find((m) => m.includes("emailbison.push-list"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      evt: "emailbison.push-list",
      by: "amy@nsight.example",
      campaignId: 7,
      listId: LIST_ID,
      attached: 2,
      skipped: 1,
    });
    logSpy.mockRestore();
  });

  test("422 when every plausible email fails the strict gate upstream", async () => {
    h.pushLeads.mockResolvedValue({
      attached: 0,
      skipped: 2,
      message: "no valid email addresses",
    });
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("no members with an email address");
  });

  test("502 with the upstream message on a BisonApiError", async () => {
    h.pushLeads.mockRejectedValue(new BisonApiError(500, "EmailBison answered 500"));
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error).toBe("EmailBison answered 500");
  });
});
