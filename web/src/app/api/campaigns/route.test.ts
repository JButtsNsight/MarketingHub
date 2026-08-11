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
  getContactList: vi.fn(),
  getSendableMembers: vi.fn(),
  getSuppressedSet: vi.fn(),
  prepareRecipients: vi.fn(),
  createCampaign: vi.fn(),
  findActiveDuplicateCampaign: vi.fn(),
  listCampaignsWithCounts: vi.fn(),
}));

// Sentinel client threaded by the route into every repo call (Wave 4).
const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
}));

vi.mock("@/lib/templates/repo", () => ({
  getTemplate: h.getTemplate,
}));

vi.mock("@/lib/monday/boards", () => ({
  getBoardMeta: h.getBoardMeta,
  fetchBoardRecipients: h.fetchBoardRecipients,
}));

vi.mock("@/lib/contacts/repo", () => ({
  getContactList: h.getContactList,
  getSendableMembers: h.getSendableMembers,
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
const LIST_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const validBody = {
  name: "July Reminders",
  templateId: TEMPLATE_ID,
  contactListId: LIST_ID,
  sendDate: "2999-01-02",
  sendTime: "09:00",
  sendTimezone: "America/Chicago",
};

const textTemplate = {
  id: TEMPLATE_ID,
  name: "Reminder",
  type: "text",
  body: "Hi {{firstName}}, our summer special starts soon.",
};

const mondayList = {
  id: LIST_ID,
  name: "Patient board",
  source: "monday",
  monday_board_id: "123456",
  monday_board_name: "Patients",
  monday_phone_column_id: "phone_col",
  contact_count: 0,
};

const csvList = {
  id: LIST_ID,
  name: "August sheet",
  source: "csv",
  storage_path: `${LIST_ID}/patients.csv`,
  original_filename: "patients.csv",
  monday_board_id: null,
  monday_phone_column_id: null,
  contact_count: 2,
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

/** Wire the full Monday-list happy path; tests override single mocks. */
function primeHappyPath() {
  h.getTemplate.mockResolvedValue(textTemplate);
  h.getContactList.mockResolvedValue(mondayList);
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

  test("400 when the chosen send slot is in the past (checked AFTER the audience is known — the earliest zone gates it)", async () => {
    primeHappyPath();
    const res = await POST(postReq({ ...validBody, sendDate: "2020-01-01" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already in the past/i);
    expect(h.fetchBoardRecipients).toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 when the contact list does not exist", async () => {
    primeHappyPath();
    h.getContactList.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/contact list/i);
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("409 duplicate-campaign BEFORE the audience fetch when an active twin exists", async () => {
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

    // matched on the snapshot triple: template + contact list + send date
    expect(h.findActiveDuplicateCampaign).toHaveBeenCalledWith(
      TEMPLATE_ID,
      LIST_ID,
      "2999-01-02",
      userDb,
    );
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.getSendableMembers).not.toHaveBeenCalled();
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

  test("404 board-not-found when the linked board no longer resolves (no zero-recipient 201)", async () => {
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

  test("201 on the Monday-list happy path (board fetched live off the list row)", async () => {
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

    // The board's existence is verified up front, by the list's saved id.
    expect(h.getBoardMeta).toHaveBeenCalledWith("123456");
    // No timezone column configured on this list → undefined third arg.
    expect(h.fetchBoardRecipients).toHaveBeenCalledWith(
      "123456",
      "phone_col",
      undefined,
    );
    // Sheet members are never consulted on the Monday path.
    expect(h.getSendableMembers).not.toHaveBeenCalled();
    // Suppressions are looked up for every fetched phone (nulls included —
    // the repo filters them).
    expect(h.getSuppressedSet).toHaveBeenCalledWith(
      mondayRows.map((r) => r.phoneE164),
      userDb,
    );
    // Rows are prepared against the template body + suppression set, each
    // carrying its normalized zone (none here → campaign-zone fallback; no
    // raw value ignored → no zone note).
    expect(h.prepareRecipients).toHaveBeenCalledWith(
      mondayRows.map((r) => ({ ...r, zone: null, zoneNote: null })),
      textTemplate.body,
      new Set(["+15550000003"]),
    );
    // createCampaign(input, source, messageBody, prepared, user) — the list's
    // Monday coordinates are snapshotted and the creator is the authed user.
    expect(h.createCampaign).toHaveBeenCalledTimes(1);
    const [input, source, messageBody, preparedArg, user] =
      h.createCampaign.mock.calls[0];
    expect(input).toMatchObject({
      name: "July Reminders",
      templateId: TEMPLATE_ID,
      contactListId: LIST_ID,
      sendDate: "2999-01-02",
    });
    expect(source).toEqual({
      mondayBoardId: "123456",
      mondayPhoneColumnId: "phone_col",
    });
    expect(messageBody).toBe(textTemplate.body);
    expect(preparedArg).toBe(prepared);
    expect(user).toMatchObject({ email: "amy@nsight.example" });
  });

  test("201 on the sheet-list happy path (stored members, Monday never touched)", async () => {
    primeHappyPath();
    h.getContactList.mockResolvedValue(csvList);
    h.getSendableMembers.mockResolvedValue([
      {
        id: "m1",
        list_id: LIST_ID,
        name: "Ada Lovelace",
        first_name: "Ada",
        phone_e164: "+15550000001",
        raw_phone: "(555) 000-0001",
        reason: "ok",
      },
      {
        id: "m2",
        list_id: LIST_ID,
        name: "Grace Hopper",
        first_name: "Grace",
        phone_e164: "+15550000002",
        raw_phone: "(555) 000-0002",
        reason: "ok",
      },
    ]);
    h.prepareRecipients.mockReturnValue([
      { monday_item_id: null, status: "pending" },
      { monday_item_id: null, status: "pending" },
    ]);

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);

    // The whole Monday integration is bypassed for sheet lists.
    expect(h.getBoardMeta).not.toHaveBeenCalled();
    expect(h.fetchBoardRecipients).not.toHaveBeenCalled();
    expect(h.getSendableMembers).toHaveBeenCalledWith(LIST_ID, userDb);

    // Members map to source rows (no mondayItemId; no timezone cell → null).
    expect(h.prepareRecipients).toHaveBeenCalledWith(
      [
        {
          name: "Ada Lovelace",
          firstName: "Ada",
          phoneE164: "+15550000001",
          rawPhone: "(555) 000-0001",
          zone: null,
          zoneNote: null,
        },
        {
          name: "Grace Hopper",
          firstName: "Grace",
          phoneE164: "+15550000002",
          rawPhone: "(555) 000-0002",
          zone: null,
          zoneNote: null,
        },
      ],
      textTemplate.body,
      new Set(["+15550000003"]),
    );

    // Sheet-sourced campaigns snapshot NULL Monday coordinates.
    const [, source] = h.createCampaign.mock.calls[0];
    expect(source).toEqual({ mondayBoardId: null, mondayPhoneColumnId: null });
  });

  test("Monday rows' rawTimezone normalizes onto the source rows; the list's timezone column id travels to the fetch", async () => {
    primeHappyPath();
    h.getContactList.mockResolvedValue({
      ...mondayList,
      monday_timezone_column_id: "tz_col",
    });
    h.fetchBoardRecipients.mockResolvedValue([
      { ...mondayRows[0], rawTimezone: "ht" },
      { ...mondayRows[1], rawTimezone: "Springfield" }, // unknown → fallback
    ]);

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);

    expect(h.fetchBoardRecipients).toHaveBeenCalledWith(
      "123456",
      "phone_col",
      "tz_col",
    );
    const [rows] = h.prepareRecipients.mock.calls[0];
    expect(rows[0].zone).toBe("Pacific/Honolulu");
    expect(rows[0].zoneNote).toBeNull();
    // The ignored value is not silent: a per-row note travels to last_error.
    expect(rows[1].zone).toBeNull();
    expect(rows[1].zoneNote).toBe(
      "unrecognized timezone, campaign zone used (raw: Springfield)",
    );
  });

  test("sheet members' timezone cells normalize per row (unknown → null, campaign-zone fallback)", async () => {
    primeHappyPath();
    h.getContactList.mockResolvedValue(csvList);
    h.getSendableMembers.mockResolvedValue([
      {
        id: "m1",
        list_id: LIST_ID,
        name: "Ada Lovelace",
        first_name: "Ada",
        phone_e164: "+15550000001",
        raw_phone: "(555) 000-0001",
        reason: "ok",
        timezone: "et",
      },
      {
        id: "m2",
        list_id: LIST_ID,
        name: "Grace Hopper",
        first_name: "Grace",
        phone_e164: "+15550000002",
        raw_phone: "(555) 000-0002",
        reason: "ok",
        timezone: "EST5EDT", // not a send zone
      },
    ]);
    h.prepareRecipients.mockReturnValue([
      { monday_item_id: null, status: "pending" },
    ]);

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);

    const [rows] = h.prepareRecipients.mock.calls[0];
    expect(rows.map((r: { zone: string | null }) => r.zone)).toEqual([
      "America/New_York",
      null,
    ]);
    // Member cells are VERBATIM in the DB; the ignored one gets a note here.
    expect(
      rows.map((r: { zoneNote: string | null }) => r.zoneNote),
    ).toEqual([
      null,
      "unrecognized timezone, campaign zone used (raw: EST5EDT)",
    ]);
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

describe("POST /api/campaigns — tracked links (SMS_LINK_BASE_URL)", () => {
  const linkedPrepared = [
    {
      monday_item_id: "1",
      name: "Ada Lovelace",
      first_name: "Ada",
      phone_e164: "+15550000001",
      rendered_text: "Hi Ada, book at https://book.example.com/slots today",
      status: "pending",
      last_error: null,
    },
    {
      monday_item_id: "4",
      name: "Stop Listed",
      first_name: "Stop",
      phone_e164: "+15550000003",
      rendered_text: "Hi Stop, book at https://book.example.com/slots today",
      status: "suppressed",
      last_error: "suppressed: phone is on the STOP list",
    },
  ];

  afterEach(() => {
    delete process.env.SMS_LINK_BASE_URL;
  });

  test("rewrites pending rows' URLs to /l/<slug> and attaches the link pairs", async () => {
    process.env.SMS_LINK_BASE_URL = "https://mh.example.com";
    primeHappyPath();
    h.prepareRecipients.mockReturnValue(linkedPrepared);

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);

    const passed = h.createCampaign.mock.calls[0][3];
    // pending row: URL rewritten, slug pair attached
    expect(passed[0].rendered_text).toMatch(
      /^Hi Ada, book at https:\/\/mh\.example\.com\/l\/[0-9A-Za-z]{8} today$/,
    );
    expect(passed[0].links).toHaveLength(1);
    expect(passed[0].links[0]).toEqual({
      slug: expect.stringMatching(/^[0-9A-Za-z]{8}$/),
      targetUrl: "https://book.example.com/slots",
    });
    // suppressed row: untouched audit snapshot, no links
    expect(passed[1].rendered_text).toBe(
      "Hi Stop, book at https://book.example.com/slots today",
    );
    expect(passed[1].links).toBeUndefined();
  });

  test("leaves everything untouched when SMS_LINK_BASE_URL is unset", async () => {
    primeHappyPath();
    h.prepareRecipients.mockReturnValue(linkedPrepared);

    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);

    const passed = h.createCampaign.mock.calls[0][3];
    expect(passed).toBe(linkedPrepared);
    expect(passed[0].links).toBeUndefined();
  });
});

describe("POST /api/campaigns — earliest-instant past-slot check", () => {
  // 2999-01-04 (a Friday) 08:30 = 13:30Z in ET (EST) but 18:30Z in HT; the
  // mocked "now" sits between the two instants.
  const htBody = {
    ...validBody,
    sendDate: "2999-01-04",
    sendTime: "08:30",
    sendTimezone: "Pacific/Honolulu",
  };
  const betweenEtAndHt = Date.parse("2999-01-04T15:00:00Z");
  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  test("400 when a pending recipient's zone is already past, even though the fallback zone is still ahead", async () => {
    primeHappyPath();
    h.prepareRecipients.mockReturnValue([
      {
        monday_item_id: "1",
        status: "pending",
        send_timezone: "America/New_York",
      },
      { monday_item_id: "2", status: "pending" },
    ]);
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await POST(postReq(htBody));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/already in the past/i);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("201 at the same instant when the audience is fallback-only (HT still ahead)", async () => {
    primeHappyPath(); // prepared rows carry no zones
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await POST(postReq(htBody));
    expect(res.status).toBe(201);
    expect(h.createCampaign).toHaveBeenCalledTimes(1);
  });

  test("non-pending rows' zones do not gate the check", async () => {
    primeHappyPath();
    h.prepareRecipients.mockReturnValue([
      {
        monday_item_id: "1",
        status: "skipped", // its past ET zone must not block the send
        send_timezone: "America/New_York",
      },
      { monday_item_id: "2", status: "pending" },
    ]);
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(betweenEtAndHt);

    const res = await POST(postReq(htBody));
    expect(res.status).toBe(201);
  });
});
