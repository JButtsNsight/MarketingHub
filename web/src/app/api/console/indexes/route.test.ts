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
  listIndexes: vi.fn(),
  dropIndex: vi.fn(),
  runQuery: vi.fn(),
  listColumns: vi.fn(),
}));

vi.mock("@/lib/console/dbobjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/dbobjects")>();
  return { ...actual, listIndexes: h.listIndexes, dropIndex: h.dropIndex };
});

vi.mock("@/lib/console/pgmeta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/pgmeta")>();
  return { ...actual, runQuery: h.runQuery, listColumns: h.listColumns };
});

import { DELETE, GET, POST } from "./route";

/** The SQL of the last runQuery call. */
function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

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
  return { "x-amzn-oidc-data": marketingToken, "content-type": "application/json" };
}

function getReq(headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/console/indexes", { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = marketingHeaders(),
) {
  return new Request("http://x/api/console/indexes", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PK_INDEX = {
  schema: "marketinghub",
  table: "templates",
  name: "templates_pkey",
  isUnique: true,
  isPrimary: true,
  definition: "CREATE UNIQUE INDEX templates_pkey ON marketinghub.templates USING btree (id)",
  bytes: 8192,
};
const NAME_INDEX = {
  schema: "marketinghub",
  table: "templates",
  name: "templates_name_idx",
  isUnique: false,
  isPrimary: false,
  definition: "CREATE INDEX templates_name_idx ON marketinghub.templates USING btree (name)",
  bytes: 16384,
};

describe("GET /api/console/indexes", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq({}))).status).toBe(401);
    expect((await GET(getReq({ "x-amzn-oidc-data": viewersToken }))).status).toBe(403);
    expect(h.listIndexes).not.toHaveBeenCalled();
  });

  test("merges idx_scan onto the foundation index list", async () => {
    h.listIndexes.mockResolvedValue([PK_INDEX, NAME_INDEX]);
    // idx_scan arrives as a string (int8) and for only one of the two indexes.
    h.runQuery.mockResolvedValue([
      {
        schema: "marketinghub",
        table: "templates",
        name: "templates_name_idx",
        idx_scan: "42",
      },
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { indexes: Array<Record<string, unknown>> };
    const byName = Object.fromEntries(body.indexes.map((ix) => [ix.name, ix]));
    expect(byName["templates_name_idx"].idxScan).toBe(42);
    expect(byName["templates_pkey"].idxScan).toBe(0); // no stat row → default 0
    expect(byName["templates_name_idx"].bytes).toBe(16384);
  });
});

describe("POST /api/console/indexes (create)", () => {
  test("401/403 before any DDL", async () => {
    const body = {
      schema: "marketinghub",
      table: "templates",
      name: "templates_name_idx",
      columns: ["name"],
    };
    expect((await POST(bodyReq("POST", body, {}))).status).toBe(401);
    expect(
      (await POST(bodyReq("POST", body, { "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listColumns).not.toHaveBeenCalled();
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 when the body is missing columns", async () => {
    const res = await POST(
      bodyReq("POST", { schema: "marketinghub", table: "templates", name: "x" }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("builds a quoted CREATE INDEX after existence-checking columns", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "id" },
      { schema: "marketinghub", table: "templates", name: "name" },
    ]);
    h.runQuery.mockResolvedValue([]);

    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        name: "templates_name_idx",
        columns: ["name"],
        method: "btree",
      }),
    );
    expect(res.status).toBe(201);
    expect(lastSql()).toBe(
      'create index "templates_name_idx" on "marketinghub"."templates" using btree ("name")',
    );
  });

  test("unique + multi-column composite index", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "name" },
      { schema: "marketinghub", table: "templates", name: "channel" },
    ]);
    h.runQuery.mockResolvedValue([]);

    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        name: "templates_name_channel_uq",
        columns: ["name", "channel"],
        unique: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(lastSql()).toBe(
      'create unique index "templates_name_channel_uq" on "marketinghub"."templates" using btree ("name", "channel")',
    );
  });

  test("400 with a real message when a column does not exist — no DDL runs", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "id" },
    ]);
    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        name: "bad_idx",
        columns: ["nope"],
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("unknown column");
    // listColumns ran; the CREATE never did.
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 for a schema outside the managed set — before any introspection", async () => {
    const res = await POST(
      bodyReq("POST", {
        schema: "pg_catalog",
        table: "pg_class",
        name: "x_idx",
        columns: ["oid"],
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("schema not managed");
    expect(h.listColumns).not.toHaveBeenCalled();
  });

  test("surfaces a Postgres error (duplicate name) as a 400 with the real message", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "name" },
    ]);
    h.runQuery.mockRejectedValue(
      new Error('[console:pgmeta] query failed: relation "templates_name_idx" already exists'),
    );
    const res = await POST(
      bodyReq("POST", {
        schema: "marketinghub",
        table: "templates",
        name: "templates_name_idx",
        columns: ["name"],
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("already exists");
  });
});

describe("DELETE /api/console/indexes (drop)", () => {
  test("401/403 before any DDL", async () => {
    const body = { schema: "marketinghub", name: "templates_name_idx" };
    expect((await DELETE(bodyReq("DELETE", body, {}))).status).toBe(401);
    expect(
      (await DELETE(bodyReq("DELETE", body, { "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.dropIndex).not.toHaveBeenCalled();
  });

  test("delegates to the foundation dropIndex and returns ok", async () => {
    h.dropIndex.mockResolvedValue(undefined);
    const res = await DELETE(
      bodyReq("DELETE", { schema: "marketinghub", name: "templates_name_idx" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.dropIndex).toHaveBeenCalledWith("marketinghub", "templates_name_idx");
  });

  test("400 with the real message when the foundation refuses (primary key)", async () => {
    h.dropIndex.mockRejectedValue(
      new Error(
        "[console:dbobjects] drop-index failed: marketinghub.templates_pkey backs a primary key — drop the constraint instead",
      ),
    );
    const res = await DELETE(
      bodyReq("DELETE", { schema: "marketinghub", name: "templates_pkey" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("backs a primary key");
  });

  test("400 when the body is missing the index name", async () => {
    const res = await DELETE(bodyReq("DELETE", { schema: "marketinghub" }));
    expect(res.status).toBe(400);
    expect(h.dropIndex).not.toHaveBeenCalled();
  });
});
