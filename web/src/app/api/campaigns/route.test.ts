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
import { MondayConfigError } from "@/lib/monday/client";

// Mock the server-only repos + Monday transport; the route is the unit under
// test (render/schedule/schema are pure and stay real).
const h = vi.hoisted(() => ({
  getTemplate: vi.fn(),
  getBoardMeta: vi.fn(),
  fetchBoardRecipients: vi.fn(),
  getSuppressedSet: vi.fn(),
  prepareRecipients: vi.fn(),
  createCampaign: vi.fn(),
  findActiveDuplicateCampaign: vi.fn(),
  listCampaignsWithCounts: vi.fn(),
}));

vi.mock("@/lib/templates/repo", () => ({
  getTemplate: h.getTemplate,
}));

vi.mock("@/lib/monday/boards", () => ({
  getBoardMeta: h.getBoardMeta,
  fetchBoardRecipients: h.fetchBoardRecipients,
}));

vi.mock("@/lib/sms/repo", () => ({
  getSuppressedSet: h.getSuppressedSet,
  prepareRecipients: h.prepareRecipients,
  createCampaign: h.createCampaign,
  findActiveDuplicateCampaign: h.findActiveDuplicateCampaign,
  listCampaignsWithCounts: h.listCampaignsWithCounts,
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

const TEMPLATE_ID = "3e2f8c1a-6a51-4a2e-9d3e-2f1b7c9d0e4f";

const validBody = {
  name: "July Reminders",
  templateId: TEMPLATE_ID,
  mondayBoardId: "https://acme.monday.com/boards/123456/views/789",
  mondayPhoneColumnId: "phone_col",
  sendDate: "2999-01-02",
};

const textTemplate = {
  id: TEMPLATE_ID,
  name: "Reminder",
  type: "text",
  body: "Hi {{firstName}}, our summer special starts soon.",
};

const mondayRows = [
  {
    mondayItemId: "1",
    name: "Ada Lovelace",
    firstName: "Ada",
    phoneE164: "+15550000001",
    rawPhone: "(555) 000-0001",
  },
  {
    mondayItemId: "2",
    name: "Grace Hopper",
    firstName: "Grace",
    phoneE164: "+15550000002",
    rawPhone: "(555) 000-0002",
  },
  {
    mondayItemId: "3",
    name: "No Phone",
    firstName: "No",
    phoneE164: null,
    rawPhone: "n/a",
  },
  {
    mondayItemId: "4",
    name: "Stop Listed",
    firstName: "Stop",
    phoneE164: "+15550000003",
    rawPhone: "(555) 000-0003",
  },
];

const prepared = [
  { monday_item_id: "1", status: "pending" },
  { monday_item_id: "2", status: "pending" },
  { monday_item_id: "3", status: "skipped" },
  { monday_item_id: "4", status: "suppressed" },
];

function postReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/campaigns", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Wire the full happy path; individual tests override single mocks. */
function primeHappyPath() {
  h.getTemplate.mockResolvedValue(textTemplate);
  h.findActiveDuplicateCampaign.mockResolvedValue(null);
  h.getBoardMeta.mockResolvedValue({
    id: "123456",
    name: "Patients",
    columns: [{ id: "phone_col", title: "Phone", type: "phone" }],
  });
  h.fetchBoardRecipients.mockResolvedValue(mondayRows);
  h.getSuppressedSet.mockResolvedValue(new Set(["+15550000003"]));
  h.prepareRecipients.mockReturnValue(prepared);
  h.createCampaign.mockResolvedValue({ id: "camp-1", status: "scheduled" });
}

describe("POST /api/campaigns", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await POST(
      postReq(validBody, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const res = await POST(
      postReq(validBody, {
        "x-amzn-oidc-data": viewersToken,
        "content-type": "application/json",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 + issues when the body fails zod validation", async () => {
    const res = await POST(postReq({ ...validBody, templateId: "nope" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues).toBeDefined();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 when the template does not exist", async () => {
    primeHappyPath();
    h.getTemplate.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/template/i);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 when the template is not type text", async () => {
    primeHappyPath();
    h.getTemplate.mockResolvedValue({ ...textTemplate, type: "email" });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/text/i);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 naming the offenders when the template has unsupported merge fields", async () => {
    primeHappyPath();
    h.getTemplate.mockResolvedValue({
      ...textTemplate,
      body: "Hi {{firstName}}, your {{appointmentDate}} at {{clinic}}.",
    });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("appointmentDate");
    expect(json.error).toContain("clinic");
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 when the sendDate's 11:30 ET instant is in the past", async () => {
    primeHappyPath();
    const res = await POST(postReq({ ...validBody, sendDate: "2020-01-01" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/future/i);
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("409 duplicate-campaign BEFORE the Monday fetch when an active twin exists", async () => {
    primeHappyPath();
    h.findActiveDuplicateCampaign.mockResolvedValue({
      id: "camp-existing",
      status: "scheduled",
    });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("duplicate-campaign");
    expect(json.existingId).toBe("camp-existing");

    // matched on the snapshot triple (board URL already reduced to its id)
    expect(h.findActiveDuplicateCampaign).toHaveBeenCalledWith(
      TEMPLATE_ID,
      "123456",
      "2999-01-02",
    );
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("503 monday-not-configured when the Monday token is unset", async () => {
    primeHappyPath();
    h.fetchBoardRecipients.mockRejectedValue(new MondayConfigError());
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("monday-not-configured");
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("503 monday-not-configured when the board-meta check itself hits the missing token", async () => {
    primeHappyPath();
    h.getBoardMeta.mockRejectedValue(new MondayConfigError());
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("monday-not-configured");
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("404 board-not-found when the board id does not resolve (no zero-recipient 201)", async () => {
    primeHappyPath();
    h.getBoardMeta.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("board-not-found");
    expect(h.getBoardMeta).toHaveBeenCalledWith("123456");
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 naming the counts when nothing would send (zero pending recipients)", async () => {
    primeHappyPath();
    h.prepareRecipients.mockReturnValue([
      { monday_item_id: "3", status: "skipped" },
      { monday_item_id: "4", status: "suppressed" },
    ]);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/0 pending/);
    expect(json.counts).toEqual({
      pending: 0,
      skipped: 1,
      suppressed: 1,
      total: 2,
    });
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("201 with id + counts on the happy path (board URL reduced to its id)", async () => {
    primeHappyPath();
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("camp-1");
    expect(json.counts).toEqual({
      pending: 2,
      skipped: 1,
      suppressed: 1,
      total: 4,
    });

    // The board's existence is verified up front, by its numeric id.
    expect(h.getBoardMeta).toHaveBeenCalledWith("123456");
    // The pasted board URL travels as its numeric id.
    expect(h.fetchBoardRecipients).toHaveBeenCalledWith("123456", "phone_col");
    // Suppressions are looked up for every fetched phone (nulls included —
    // the repo filters them).
    expect(h.getSuppressedSet).toHaveBeenCalledWith(
      mondayRows.map((r) => r.phoneE164),
    );
    // Rows are prepared against the template body + suppression set.
    expect(h.prepareRecipients).toHaveBeenCalledWith(
      mondayRows,
      textTemplate.body,
      new Set(["+15550000003"]),
    );
    // createCampaign(input, messageBody, prepared, user) — template body is
    // passed explicitly and the creator is the authed user.
    expect(h.createCampaign).toHaveBeenCalledTimes(1);
    const [input, messageBody, preparedArg, user] =
      h.createCampaign.mock.calls[0];
    expect(input).toMatchObject({
      name: "July Reminders",
      templateId: TEMPLATE_ID,
      mondayBoardId: "123456",
      mondayPhoneColumnId: "phone_col",
      sendDate: "2999-01-02",
    });
    expect(messageBody).toBe(textTemplate.body);
    expect(preparedArg).toBe(prepared);
    expect(user).toMatchObject({ email: "amy@nsight.example" });
  });
});

describe("GET /api/campaigns", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(new Request("http://x/api/campaigns"));
    expect(res.status).toBe(401);
    expect(h.listCampaignsWithCounts).not.toHaveBeenCalled();
  });

  test("200 with the campaigns + counts list", async () => {
    const rows = [{ id: "camp-1", counts: { pending: 2 } }];
    h.listCampaignsWithCounts.mockResolvedValue(rows);
    const res = await GET(
      new Request("http://x/api/campaigns", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.campaigns).toEqual(rows);
  });
});
