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
  listTables: vi.fn(),
  listColumns: vi.fn(),
  query: null as unknown,
}));

vi.mock("@/lib/console/pgmeta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/pgmeta")>();
  return { ...actual, listTables: h.listTables, listColumns: h.listColumns };
});

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => h.query,
}));

import { GET } from "./route";

/** Chainable-thenable PostgREST stub: every builder method returns `this`. */
function makeQuery(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[][]> = {};
  const q: Record<string, unknown> = {};
  for (const m of ["schema", "from", "select", "ilike", "order", "limit"]) {
    q[m] = vi.fn((...args: unknown[]) => {
      (calls[m] ??= []).push(args);
      return q;
    });
  }
  q.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  q.calls = calls;
  return q;
}

const CAMPAIGNS = {
  id: 1,
  schema: "marketinghub",
  name: "campaigns",
  rls_enabled: false,
  rls_forced: false,
  live_rows_estimate: 0,
  bytes: 0,
  size: "0 bytes",
  comment: null,
  primary_keys: [{ schema: "marketinghub", table_name: "campaigns", name: "id" }],
  relationships: [
    {
      constraint_name: "campaigns_template_id_fkey",
      source_schema: "marketinghub",
      source_table_name: "campaigns",
      source_column_name: "template_id",
      target_table_schema: "marketinghub",
      target_table_name: "templates",
      target_column_name: "id",
    },
    {
      constraint_name: "campaigns_owner_fkey",
      source_schema: "marketinghub",
      source_table_name: "campaigns",
      source_column_name: "owner_id",
      target_table_schema: "auth",
      target_table_name: "users",
      target_column_name: "id",
    },
  ],
};

const TEMPLATES = { ...CAMPAIGNS, id: 2, name: "templates", relationships: [] };

const TEMPLATE_COLUMNS = [
  {
    id: "2.1",
    table_id: 2,
    schema: "marketinghub",
    table: "templates",
    name: "id",
    ordinal_position: 1,
    data_type: "uuid",
    format: "uuid",
    is_nullable: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    default_value: null,
    enums: [],
    comment: null,
  },
  {
    id: "2.2",
    table_id: 2,
    schema: "marketinghub",
    table: "templates",
    name: "name",
    ordinal_position: 2,
    data_type: "text",
    format: "text",
    is_nullable: true,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    default_value: null,
    enums: [],
    comment: null,
  },
];

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
  h.listTables.mockReset();
  h.listColumns.mockReset();
  h.listTables.mockResolvedValue([CAMPAIGNS, TEMPLATES]);
  h.listColumns.mockResolvedValue(TEMPLATE_COLUMNS);
  h.query = makeQuery({
    data: [
      { id: "t1", name: "Alpha" },
      { id: "t2", name: "Beta" },
    ],
    error: null,
  });
});

afterEach(() => {
  clearAlbEnv();
});

function req(qs: string, token: string | null = marketingToken) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-amzn-oidc-data"] = token;
  return new Request(`http://x/api/console/fk-options?${qs}`, { headers });
}

describe("GET /api/console/fk-options", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(req("schema=marketinghub&table=campaigns", null))).status).toBe(401);
    expect(
      (await GET(req("schema=marketinghub&table=campaigns", viewersToken))).status,
    ).toBe(403);
    expect(h.listTables).not.toHaveBeenCalled();
  });

  test("relationships mode returns the table's FK map", async () => {
    const res = await GET(req("schema=marketinghub&table=campaigns"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      relationships: Array<{ column: string; targetTable: string }>;
    };
    expect(body.relationships).toEqual([
      {
        column: "template_id",
        targetSchema: "marketinghub",
        targetTable: "templates",
        targetColumn: "id",
      },
      {
        column: "owner_id",
        targetSchema: "auth",
        targetTable: "users",
        targetColumn: "id",
      },
    ]);
  });

  test("404 for a table outside the exposed schemas or not present", async () => {
    expect((await GET(req("schema=pg_catalog&table=pg_class"))).status).toBe(404);
    expect((await GET(req("schema=marketinghub&table=nope"))).status).toBe(404);
  });

  test("options mode returns referenced rows labelled by display column", async () => {
    const res = await GET(
      req("schema=marketinghub&table=campaigns&column=template_id"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      column: string;
      target: { schema: string; table: string; displayColumn: string };
      options: Array<{ value: string; label: string }>;
    };
    expect(body.column).toBe("template_id");
    expect(body.target).toMatchObject({
      schema: "marketinghub",
      table: "templates",
      valueColumn: "id",
      displayColumn: "name",
    });
    expect(body.options).toEqual([
      { value: "t1", label: "Alpha · t1" },
      { value: "t2", label: "Beta · t2" },
    ]);
    // Read the referenced table's value + display columns, nothing else.
    const q = h.query as { calls: Record<string, unknown[][]> };
    expect(q.calls.from[0]).toEqual(["templates"]);
    expect(q.calls.select[0]).toEqual(["id,name"]);
  });

  test("400 when the column is not a foreign key", async () => {
    const res = await GET(
      req("schema=marketinghub&table=campaigns&column=subject"),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "not a foreign key",
    );
    // The row fetch is never attempted for a non-FK column.
    const q = h.query as { calls: Record<string, unknown[][]> };
    expect(q.calls.select).toBeUndefined();
  });

  test("FK into a non-exposed schema is reported unsupported (no query)", async () => {
    const res = await GET(
      req("schema=marketinghub&table=campaigns&column=owner_id"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { options: unknown[]; unsupported: boolean };
    expect(body.unsupported).toBe(true);
    expect(body.options).toEqual([]);
    expect(h.listColumns).not.toHaveBeenCalled();
  });
});
