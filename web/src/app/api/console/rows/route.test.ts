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

const h = vi.hoisted(() => ({
  getEditorTable: vi.fn(),
  getRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRows: vi.fn(),
}));

vi.mock("@/lib/console/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/tables")>();
  return {
    ...actual,
    getEditorTable: h.getEditorTable,
    getRows: h.getRows,
    insertRow: h.insertRow,
    updateRow: h.updateRow,
    deleteRows: h.deleteRows,
  };
});

import { DELETE, GET, PATCH, POST } from "./route";

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

const META = {
  schema: "marketinghub",
  name: "templates",
  rowsEstimate: 8,
  size: "96 kB",
  rlsEnabled: true,
  comment: null,
  primaryKeys: ["id"],
  sensitive: false,
  columns: [
    { name: "id" },
    { name: "name" },
  ],
};

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.getEditorTable.mockResolvedValue(META);
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

function getReq(qs: string, headers: HeadersInit = marketingHeaders()) {
  return new Request(`http://x/api/console/rows?${qs}`, { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = marketingHeaders(),
) {
  return new Request("http://x/api/console/rows", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/console/rows", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq("schema=marketinghub&table=templates", {}))).status).toBe(401);
    expect(
      (
        await GET(
          getReq("schema=marketinghub&table=templates", {
            "x-amzn-oidc-data": viewersToken,
          }),
        )
      ).status,
    ).toBe(403);
    expect(h.getEditorTable).not.toHaveBeenCalled();
  });

  test("404 for an unknown table", async () => {
    h.getEditorTable.mockResolvedValue(null);
    const res = await GET(getReq("schema=marketinghub&table=nope"));
    expect(res.status).toBe(404);
    expect(h.getRows).not.toHaveBeenCalled();
  });

  test("passes page/sort/filters through after validating columns", async () => {
    h.getRows.mockResolvedValue({ rows: [{ id: "a" }], total: 1 });
    const filters = JSON.stringify([{ column: "name", op: "ilike", value: "%x%" }]);
    const res = await GET(
      getReq(
        `schema=marketinghub&table=templates&page=1&pageSize=25&sort=name&dir=desc&filters=${encodeURIComponent(filters)}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: [{ id: "a" }], total: 1 });
    expect(h.getRows).toHaveBeenCalledWith(META, {
      page: 1,
      pageSize: 25,
      sort: { column: "name", ascending: false },
      filters: [{ column: "name", op: "ilike", value: "%x%" }],
    });
  });

  test("400 on unknown filter column, bad operator, or malformed filters JSON", async () => {
    const unknownCol = JSON.stringify([{ column: "evil", op: "eq", value: "1" }]);
    expect(
      (
        await GET(
          getReq(
            `schema=marketinghub&table=templates&filters=${encodeURIComponent(unknownCol)}`,
          ),
        )
      ).status,
    ).toBe(400);

    const badOp = JSON.stringify([{ column: "name", op: "drop", value: "1" }]);
    expect(
      (
        await GET(
          getReq(
            `schema=marketinghub&table=templates&filters=${encodeURIComponent(badOp)}`,
          ),
        )
      ).status,
    ).toBe(400);

    expect(
      (await GET(getReq("schema=marketinghub&table=templates&filters=notjson"))).status,
    ).toBe(400);
    expect(h.getRows).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/rows", () => {
  test("201 with the created row", async () => {
    h.insertRow.mockResolvedValue({ id: "new", name: "Hello" });
    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        values: { name: "Hello" },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ row: { id: "new", name: "Hello" } });
  });

  test("403 on a read-only table (audit trail) — insert refused before any write", async () => {
    h.getEditorTable.mockResolvedValue({
      ...META,
      schema: "marketinghub",
      name: "console_query_history",
    });
    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "console_query_history",
        values: { sql: "x" },
      }),
    );
    expect(res.status).toBe(403);
    expect(h.insertRow).not.toHaveBeenCalled();
  });

  test("400 for unknown columns; 400 with the real Postgres message on constraint errors", async () => {
    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        values: { evil: 1 },
      }),
    );
    expect(res.status).toBe(400);
    expect(h.insertRow).not.toHaveBeenCalled();

    h.insertRow.mockRejectedValue(
      new Error('[console:tables] insert-row failed: null value in column "name"'),
    );
    const res2 = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        values: { name: "x" },
      }),
    );
    expect(res2.status).toBe(400);
    const body = (await res2.json()) as { error: string };
    expect(body.error).toContain('null value in column "name"');
  });
});

describe("PATCH /api/console/rows", () => {
  test("updates by full PK and returns the row", async () => {
    h.updateRow.mockResolvedValue({ id: "a", name: "New" });
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "marketinghub",
        table: "templates",
        pk: { id: "a" },
        patch: { name: "New" },
      }),
    );
    expect(res.status).toBe(200);
    expect(h.updateRow).toHaveBeenCalledWith(META, { id: "a" }, { name: "New" });
  });

  test("400 on incomplete PK, 404 when the row vanished, 409 on PK-less tables", async () => {
    expect(
      (
        await PATCH(
          bodyReq("PATCH", {
            schema: "marketinghub",
            table: "templates",
            pk: {},
            patch: { name: "x" },
          }),
        )
      ).status,
    ).toBe(400);

    h.updateRow.mockResolvedValue(null);
    expect(
      (
        await PATCH(
          bodyReq("PATCH", {
            schema: "marketinghub",
            table: "templates",
            pk: { id: "gone" },
            patch: { name: "x" },
          }),
        )
      ).status,
    ).toBe(404);

    h.getEditorTable.mockResolvedValue({ ...META, primaryKeys: [] });
    expect(
      (
        await PATCH(
          bodyReq("PATCH", {
            schema: "marketinghub",
            table: "templates",
            pk: { id: "a" },
            patch: { name: "x" },
          }),
        )
      ).status,
    ).toBe(409);
  });
});

describe("DELETE /api/console/rows", () => {
  test("deletes by full PKs and reports the count", async () => {
    h.deleteRows.mockResolvedValue(2);
    const res = await DELETE(
      bodyReq("DELETE", {
        schema: "marketinghub",
        table: "templates",
        keys: [{ id: "a" }, { id: "b" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });
  });

  test("409 on PK-less tables, 400 on incomplete keys", async () => {
    h.getEditorTable.mockResolvedValue({ ...META, primaryKeys: [] });
    expect(
      (
        await DELETE(
          bodyReq("DELETE", {
            schema: "marketinghub",
            table: "templates",
            keys: [{ id: "a" }],
          }),
        )
      ).status,
    ).toBe(409);

    h.getEditorTable.mockResolvedValue(META);
    expect(
      (
        await DELETE(
          bodyReq("DELETE", {
            schema: "marketinghub",
            table: "templates",
            keys: [{ wrong: "a" }],
          }),
        )
      ).status,
    ).toBe(400);
    expect(h.deleteRows).not.toHaveBeenCalled();
  });
});
