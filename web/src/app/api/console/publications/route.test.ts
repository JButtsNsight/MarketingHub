// @vitest-environment node
// The route runs the real (jose ES256) auth path; node env avoids the jsdom
// cross-realm Uint8Array mismatch that breaks WebCrypto verify.
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

// The foundation data layer is mocked; the SQL-safety + validation logic under
// test lives in the route itself. dbobjects.OBJECT_SCHEMAS must be provided
// because the route imports it.
const h = vi.hoisted(() => ({
  listPublications: vi.fn(),
  dropPublication: vi.fn(),
  runQuery: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock("@/lib/console/dbobjects", () => ({
  listPublications: h.listPublications,
  dropPublication: h.dropPublication,
  OBJECT_SCHEMAS: ["public", "marketinghub", "storage"],
}));

vi.mock("@/lib/console/pgmeta", () => ({
  runQuery: h.runQuery,
  listTables: h.listTables,
}));

import { DELETE, GET, PATCH, POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["mh-section-platform"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.listPublications.mockReset();
  h.dropPublication.mockReset();
  h.runQuery.mockReset();
  h.listTables.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function headers(token = platformToken): HeadersInit {
  return { "x-amzn-oidc-data": token, "content-type": "application/json" };
}

function req(method: string, body?: unknown, token = platformToken): Request {
  return new Request("http://x/api/console/publications", {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The SQL of the last runQuery call. */
function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

const PUBS = [
  {
    name: "supabase_realtime",
    owner: "supabase_admin",
    allTables: false,
    insert: true,
    update: true,
    delete: true,
    truncate: false,
    tableCount: 1,
  },
  {
    name: "all_pub",
    owner: "postgres",
    allTables: true,
    insert: true,
    update: true,
    delete: true,
    truncate: true,
    tableCount: -1,
  },
];

const LIVE_TABLES = [
  { schema: "marketinghub", name: "templates" },
  { schema: "marketinghub", name: "sms_campaigns" },
  { schema: "public", name: "widgets" },
];

const ALL_OPS = { insert: true, update: true, delete: true, truncate: true };

describe("GET /api/console/publications", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req("GET", undefined, ""));
    expect(res.status).toBe(401);
    expect(h.listPublications).not.toHaveBeenCalled();
  });

  test("403 when missing the platform section", async () => {
    const res = await GET(req("GET", undefined, viewersToken));
    expect(res.status).toBe(403);
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect((await GET(req("GET", undefined, marketingToken))).status).toBe(403);
    expect(h.listPublications).not.toHaveBeenCalled();

    h.listPublications.mockResolvedValue([]);
    h.runQuery.mockResolvedValue([]);
    h.listTables.mockResolvedValue([]);
    expect((await GET(req("GET", undefined, adminToken))).status).toBe(200);
  });

  test("200: publications carry member tables; all-tables pub omits them", async () => {
    h.listPublications.mockResolvedValue(PUBS);
    h.runQuery.mockResolvedValue([
      { pubname: "supabase_realtime", schemaname: "marketinghub", tablename: "templates" },
      // A row for the all-tables pub must NOT leak into its tables[].
      { pubname: "all_pub", schemaname: "public", tablename: "widgets" },
    ]);
    h.listTables.mockResolvedValue(LIVE_TABLES);

    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();

    const realtime = json.publications.find(
      (p: { name: string }) => p.name === "supabase_realtime",
    );
    expect(realtime.tables).toEqual(["marketinghub.templates"]);
    const all = json.publications.find((p: { name: string }) => p.name === "all_pub");
    expect(all.tables).toEqual([]);
    expect(json.availableTables).toContainEqual({
      schema: "marketinghub",
      name: "templates",
    });
  });
});

describe("POST /api/console/publications (create)", () => {
  test("400 on an invalid publication name (never reaches SQL)", async () => {
    const res = await POST(
      req("POST", { name: "bad; drop table x", publish: ALL_OPS }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 when no publish operation is selected", async () => {
    const res = await POST(
      req("POST", {
        name: "p",
        publish: { insert: false, update: false, delete: false, truncate: false },
      }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 when allTables is combined with an explicit table list", async () => {
    const res = await POST(
      req("POST", {
        name: "p",
        allTables: true,
        tables: [{ schema: "marketinghub", table: "templates" }],
        publish: ALL_OPS,
      }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("creates a for-all-tables publication with a fixed publish clause", async () => {
    h.runQuery.mockResolvedValue([]);
    const res = await POST(
      req("POST", { name: "realtime_pub", allTables: true, publish: ALL_OPS }),
    );
    expect(res.status).toBe(201);
    expect(lastSql()).toBe(
      `create publication "realtime_pub" for all tables with (publish = 'insert, update, delete, truncate')`,
    );
    // all-tables → no introspection needed
    expect(h.listTables).not.toHaveBeenCalled();
  });

  test("400 when a named table does not exist in live introspection", async () => {
    h.listTables.mockResolvedValue(LIVE_TABLES);
    const res = await POST(
      req("POST", {
        name: "p",
        tables: [{ schema: "marketinghub", table: "ghost" }],
        publish: ALL_OPS,
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unknown table: marketinghub.ghost");
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("creates a table-scoped publication with quoted, qualified identifiers", async () => {
    h.listTables.mockResolvedValue(LIVE_TABLES);
    h.runQuery.mockResolvedValue([]);
    const res = await POST(
      req("POST", {
        name: "tpub",
        tables: [{ schema: "marketinghub", table: "templates" }],
        publish: { insert: true, update: false, delete: false, truncate: false },
      }),
    );
    expect(res.status).toBe(201);
    expect(lastSql()).toBe(
      `create publication "tpub" for table "marketinghub"."templates" with (publish = 'insert')`,
    );
  });
});

describe("PATCH /api/console/publications (alter)", () => {
  test("404 when the publication does not exist", async () => {
    h.listPublications.mockResolvedValue(PUBS);
    const res = await PATCH(req("PATCH", { name: "nope", publish: ALL_OPS }));
    expect(res.status).toBe(404);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("changes only the publish operations", async () => {
    h.listPublications.mockResolvedValue(PUBS);
    h.runQuery.mockResolvedValue([]);
    const res = await PATCH(
      req("PATCH", {
        name: "supabase_realtime",
        publish: { insert: true, update: true, delete: false, truncate: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(lastSql()).toBe(
      `alter publication "supabase_realtime" set (publish = 'insert, update')`,
    );
  });

  test("400 when setting member tables on an all-tables publication", async () => {
    h.listPublications.mockResolvedValue(PUBS);
    const res = await PATCH(
      req("PATCH", {
        name: "all_pub",
        publish: ALL_OPS,
        tables: [{ schema: "marketinghub", table: "templates" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("replaces the member-table set on a table-scoped publication", async () => {
    h.listPublications.mockResolvedValue(PUBS);
    h.listTables.mockResolvedValue(LIVE_TABLES);
    h.runQuery.mockResolvedValue([]);
    const res = await PATCH(
      req("PATCH", {
        name: "supabase_realtime",
        publish: { insert: true, update: false, delete: false, truncate: false },
        tables: [
          { schema: "marketinghub", table: "templates" },
          { schema: "marketinghub", table: "sms_campaigns" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const sql = lastSql();
    expect(sql).toContain(`set (publish = 'insert')`);
    expect(sql).toContain(
      `set table "marketinghub"."templates", "marketinghub"."sms_campaigns"`,
    );
  });
});

describe("DELETE /api/console/publications (drop)", () => {
  test("delegates to the foundation dropPublication", async () => {
    h.dropPublication.mockResolvedValue(undefined);
    const res = await DELETE(req("DELETE", { name: "supabase_realtime" }));
    expect(res.status).toBe(200);
    expect(h.dropPublication).toHaveBeenCalledWith("supabase_realtime");
  });

  test("maps a [console:dbobjects] failure to a 400 with the stripped message", async () => {
    h.dropPublication.mockRejectedValue(
      new Error("[console:dbobjects] drop-publication failed: publication nope does not exist"),
    );
    const res = await DELETE(req("DELETE", { name: "nope" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("publication nope does not exist");
  });

  test("400 on an invalid publication name", async () => {
    const res = await DELETE(req("DELETE", { name: "1nope" }));
    expect(res.status).toBe(400);
    expect(h.dropPublication).not.toHaveBeenCalled();
  });
});
