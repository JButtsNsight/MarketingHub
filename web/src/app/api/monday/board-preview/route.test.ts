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

// Mock the Monday board helper + GraphQL transport (keeping the error classes
// real for instanceof); phone normalization stays real.
const h = vi.hoisted(() => ({
  getBoardMeta: vi.fn(),
  mondayGraphQL: vi.fn(),
}));

vi.mock("@/lib/monday/boards", () => ({
  getBoardMeta: h.getBoardMeta,
}));

vi.mock("@/lib/monday/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/monday/client")>();
  return { ...actual, mondayGraphQL: h.mondayGraphQL };
});

import { MondayConfigError } from "@/lib/monday/client";
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

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.getBoardMeta.mockReset();
  h.mondayGraphQL.mockReset();
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
  return new Request("http://x/api/monday/board-preview", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const boardMeta = {
  id: "123456",
  name: "July Patients",
  columns: [
    { id: "name_col", title: "Name", type: "text" },
    { id: "phone_col", title: "Phone", type: "phone" },
    { id: "cell_col", title: "Cell", type: "phone" },
  ],
};

function item(
  id: string,
  name: string,
  phone: string,
  columnId = "phone_col",
) {
  return {
    id,
    name,
    column_values: [{ id: columnId, text: phone, phone, country_short_name: "US" }],
  };
}

/** One first page: 2 valid, 1 invalid, 1 duplicate — cursor deliberately set. */
function primeFirstPage() {
  h.mondayGraphQL.mockResolvedValue({
    boards: [
      {
        items_page: {
          cursor: "more-pages-exist",
          items: [
            item("1", "Ada Lovelace", "(555) 000-0001"),
            item("2", "Grace Hopper", "555-000-0002"),
            item("3", "No Phone", "12345"),
            item("4", "Dupe Ada", "+1 555 000 0001"),
          ],
        },
      },
    ],
  });
}

describe("POST /api/monday/board-preview", () => {
  test("401 when unauthenticated", async () => {
    const res = await POST(
      postReq({ board: "123456" }, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
    expect(h.getBoardMeta).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      postReq(
        { board: "123456" },
        {
          "x-amzn-oidc-data": viewersToken,
          "content-type": "application/json",
        },
      ),
    );
    expect(res.status).toBe(403);
  });

  test("400 on malformed JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
  });

  test("400 + issues when board is not an id or Monday URL", async () => {
    const res = await POST(postReq({ board: "not-a-board" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.issues).toBeDefined();
    expect(h.getBoardMeta).not.toHaveBeenCalled();
  });

  test("503 monday-not-configured when the Monday token is unset", async () => {
    h.getBoardMeta.mockRejectedValue(new MondayConfigError());
    const res = await POST(postReq({ board: "123456" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("monday-not-configured");
  });

  test("404 when the board does not exist", async () => {
    h.getBoardMeta.mockResolvedValue(null);
    const res = await POST(postReq({ board: "123456" }));
    expect(res.status).toBe(404);
    expect(h.mondayGraphQL).not.toHaveBeenCalled();
  });

  test("200 preview: columns, phone columns, suggestion, classified sample, page counts", async () => {
    h.getBoardMeta.mockResolvedValue(boardMeta);
    primeFirstPage();

    // A pasted board URL reduces to its numeric id.
    const res = await POST(
      postReq({ board: "https://acme.monday.com/boards/123456/views/9" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(h.getBoardMeta).toHaveBeenCalledWith("123456");
    expect(json.boardId).toBe("123456");
    expect(json.boardName).toBe("July Patients");
    expect(json.columns).toEqual(boardMeta.columns);
    // Only type==='phone' columns are offered; the first is suggested.
    expect(json.phoneColumns).toEqual([
      { id: "phone_col", title: "Phone", type: "phone" },
      { id: "cell_col", title: "Cell", type: "phone" },
    ]);
    expect(json.suggestedPhoneColumnId).toBe("phone_col");

    expect(json.sample).toEqual([
      { name: "Ada Lovelace", phoneE164: "+15550000001", reason: "ok" },
      { name: "Grace Hopper", phoneE164: "+15550000002", reason: "ok" },
      { name: "No Phone", phoneE164: null, reason: "invalid" },
      { name: "Dupe Ada", phoneE164: "+15550000001", reason: "duplicate" },
    ]);
    expect(json.pageCounts).toEqual({
      fetched: 4,
      valid: 2,
      invalid: 1,
      duplicate: 1,
    });

    // FIRST items_page only — the cursor is non-null and must not be chased
    // (campaign creation refetches every page).
    expect(h.mondayGraphQL).toHaveBeenCalledTimes(1);
    const [, vars] = h.mondayGraphQL.mock.calls[0];
    expect(vars).toMatchObject({
      boardIds: ["123456"],
      columnIds: ["phone_col"],
    });
  });

  test("sample is capped at 25 rows while pageCounts cover the whole page", async () => {
    h.getBoardMeta.mockResolvedValue(boardMeta);
    h.mondayGraphQL.mockResolvedValue({
      boards: [
        {
          items_page: {
            cursor: null,
            items: Array.from({ length: 30 }, (_, i) =>
              item(String(i + 1), `Patient ${i + 1}`, `555000${1000 + i}`),
            ),
          },
        },
      ],
    });

    const res = await POST(postReq({ board: "123456" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sample).toHaveLength(25);
    expect(json.pageCounts.fetched).toBe(30);
    expect(json.pageCounts.valid).toBe(30);
  });

  test("200 with an empty sample when the board has no phone-type column", async () => {
    h.getBoardMeta.mockResolvedValue({
      ...boardMeta,
      columns: [{ id: "name_col", title: "Name", type: "text" }],
    });

    const res = await POST(postReq({ board: "123456" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.phoneColumns).toEqual([]);
    expect(json.suggestedPhoneColumnId).toBeNull();
    expect(json.sample).toEqual([]);
    expect(json.pageCounts).toEqual({
      fetched: 0,
      valid: 0,
      invalid: 0,
      duplicate: 0,
    });
    expect(h.mondayGraphQL).not.toHaveBeenCalled();
  });
});
