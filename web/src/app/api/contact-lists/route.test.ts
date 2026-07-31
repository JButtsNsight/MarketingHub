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

// Mock the server-only repo + Monday transport; the route (and the pure CSV
// parser it calls for real) is the unit under test.
const h = vi.hoisted(() => ({
  getBoardMeta: vi.fn(),
  createCsvList: vi.fn(),
  createMondayList: vi.fn(),
  listContactLists: vi.fn(),
}));

vi.mock("@/lib/monday/boards", () => ({
  getBoardMeta: h.getBoardMeta,
}));

vi.mock("@/lib/contacts/repo", () => ({
  createCsvList: h.createCsvList,
  createMondayList: h.createMondayList,
  listContactLists: h.listContactLists,
}));

import { GET, POST } from "./route";

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

function postReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/contact-lists", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const csvBody = {
  source: "csv",
  name: "August recall",
  filename: "patients.csv",
  content: "name,phone\nJane Doe,5559234567\nJohn Roe,5559234568\n",
};

const mondayBody = {
  source: "monday",
  name: "Patient board",
  board: "https://acme.monday.com/boards/123456/views/9",
  phoneColumnId: "phone_col",
};

describe("POST /api/contact-lists (csv)", () => {
  test("401 when unauthenticated", async () => {
    const res = await POST(
      postReq(csvBody, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
    expect(h.createCsvList).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      postReq(csvBody, {
        "x-amzn-oidc-data": viewersToken,
        "content-type": "application/json",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.createCsvList).not.toHaveBeenCalled();
  });

  test("201: parses the sheet for real, persists via the repo, returns counts", async () => {
    h.createCsvList.mockResolvedValue({ id: "list-1" });
    const res = await POST(postReq(csvBody));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("list-1");
    expect(json.counts).toEqual({ ok: 2, invalid: 0, duplicate: 0, total: 2 });

    const [name, contacts, file, user] = h.createCsvList.mock.calls[0];
    expect(name).toBe("August recall");
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      name: "Jane Doe",
      phoneE164: "+15559234567",
      reason: "ok",
    });
    expect(file).toEqual({
      filename: "patients.csv",
      content: csvBody.content,
    });
    expect(user).toEqual({ email: "amy@nsight.example" });
  });

  test("400 with the parse message on an unusable sheet", async () => {
    const res = await POST(
      postReq({ ...csvBody, content: "name,email\nJane,j@x.com\n" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no phone column/i);
    expect(h.createCsvList).not.toHaveBeenCalled();
  });

  test("400 when no row is sendable (all invalid/duplicate)", async () => {
    const res = await POST(
      postReq({ ...csvBody, content: "name,phone\nBad,123\nWorse,\n" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/no usable contacts/i);
    expect(json.counts).toMatchObject({ ok: 0, invalid: 2 });
    expect(h.createCsvList).not.toHaveBeenCalled();
  });

  test("413 when the sheet text exceeds the size cap", async () => {
    const res = await POST(
      postReq({ ...csvBody, content: "x".repeat(5 * 1024 * 1024 + 1) }),
    );
    expect(res.status).toBe(413);
    expect(h.createCsvList).not.toHaveBeenCalled();
  });
});

describe("POST /api/contact-lists (monday)", () => {
  test("201: verifies the board, snapshots its name, reduces the URL to an id", async () => {
    h.getBoardMeta.mockResolvedValue({
      id: "123456",
      name: "Patients",
      columns: [{ id: "phone_col", title: "Phone", type: "phone" }],
    });
    h.createMondayList.mockResolvedValue({ id: "list-2" });

    const res = await POST(postReq(mondayBody));
    expect(res.status).toBe(201);
    expect(h.getBoardMeta).toHaveBeenCalledWith("123456");
    expect(h.createMondayList).toHaveBeenCalledWith(
      "Patient board",
      { id: "123456", name: "Patients", phoneColumnId: "phone_col" },
      { email: "amy@nsight.example" },
    );
  });

  test("404 when the board does not resolve", async () => {
    h.getBoardMeta.mockResolvedValue(null);
    const res = await POST(postReq(mondayBody));
    expect(res.status).toBe(404);
    expect(h.createMondayList).not.toHaveBeenCalled();
  });

  test("400 when the phone column is not on the board", async () => {
    h.getBoardMeta.mockResolvedValue({
      id: "123456",
      name: "Patients",
      columns: [{ id: "other_col", title: "Other", type: "text" }],
    });
    const res = await POST(postReq(mondayBody));
    expect(res.status).toBe(400);
    expect(h.createMondayList).not.toHaveBeenCalled();
  });

  test("503 when Monday is unconfigured", async () => {
    h.getBoardMeta.mockRejectedValue(new MondayConfigError());
    const res = await POST(postReq(mondayBody));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("monday-not-configured");
  });
});

describe("GET /api/contact-lists", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(new Request("http://x/api/contact-lists"));
    expect(res.status).toBe(401);
    expect(h.listContactLists).not.toHaveBeenCalled();
  });

  test("200 with the lists", async () => {
    const rows = [{ id: "list-1", name: "August recall" }];
    h.listContactLists.mockResolvedValue(rows);
    const res = await GET(
      new Request("http://x/api/contact-lists", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lists).toEqual(rows);
  });
});
