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
  listRoles: vi.fn(),
  runQuery: vi.fn(),
}));

// listRoles stays the foundation entry point; the membership reader + the
// create/alter/drop mutators live in the route and run through runQuery, so we
// mock pgmeta's runQuery to observe/shape the SQL.
vi.mock("@/lib/console/dbobjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/dbobjects")>();
  return { ...actual, listRoles: h.listRoles };
});

vi.mock("@/lib/console/pgmeta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/pgmeta")>();
  return { ...actual, runQuery: h.runQuery };
});

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

const ROLE = {
  name: "service_role",
  isSuperuser: false,
  canLogin: true,
  canCreateRole: false,
  canCreateDb: false,
  isReplication: false,
  bypassRls: true,
  connectionLimit: -1,
  validUntil: null,
};

const MEMBERSHIP_ROW = {
  role: "authenticated",
  member: "service_role",
  admin_option: false,
  grantor: "supabase_admin",
};

/** The SQL of the last runQuery call. */
function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.listRoles.mockReset();
  h.runQuery.mockReset();
  h.listRoles.mockResolvedValue([ROLE]);
  h.runQuery.mockResolvedValue([MEMBERSHIP_ROW]);
});

afterEach(() => {
  clearAlbEnv();
});

function sectionHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  };
}

function getReq(headers: HeadersInit = sectionHeaders()) {
  return new Request("http://x/api/console/roles", { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = sectionHeaders(),
) {
  return new Request("http://x/api/console/roles", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/console/roles", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq({}))).status).toBe(401);
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listRoles).not.toHaveBeenCalled();
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": marketingToken }))).status,
    ).toBe(403);
    expect(h.listRoles).not.toHaveBeenCalled();
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": adminToken }))).status,
    ).toBe(200);
  });

  test("200 returns roles + mapped memberships", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roles: [ROLE],
      memberships: [
        {
          role: "authenticated",
          member: "service_role",
          adminOption: false,
          grantor: "supabase_admin",
        },
      ],
    });
    // The membership reader reads pg_auth_members, not user input.
    expect(lastSql()).toContain("pg_catalog.pg_auth_members");
  });
});

describe("POST /api/console/roles (create)", () => {
  test("403 for a user without the section before any write", async () => {
    const res = await POST(
      bodyReq(
        "POST",
        { name: "reporting", canLogin: true },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("201 builds CREATE ROLE with quoted name + explicit option words", async () => {
    h.runQuery.mockResolvedValue([]);
    const res = await POST(
      bodyReq("POST", {
        name: "reporting",
        canLogin: true,
        isSuperuser: false,
        connectionLimit: 5,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, name: "reporting" });
    expect(lastSql()).toBe(
      'create role "reporting" with LOGIN NOSUPERUSER CONNECTION LIMIT 5',
    );
  });

  test("passwords and valid-until reach SQL as escaped literals", async () => {
    h.runQuery.mockResolvedValue([]);
    await POST(
      bodyReq("POST", {
        name: "svc",
        canLogin: true,
        password: "s3'cret",
        validUntil: "2027-01-01 00:00:00+00",
      }),
    );
    const sql = lastSql();
    expect(sql).toContain("PASSWORD 's3''cret'");
    expect(sql).toContain("VALID UNTIL '2027-01-01 00:00:00+00'");
  });

  test("400 on an invalid identifier — never reaches runQuery", async () => {
    const res = await POST(bodyReq("POST", { name: "bad name", canLogin: true }));
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 with the real Postgres message on a collision", async () => {
    h.runQuery.mockRejectedValue(
      new Error('[console:pgmeta] query failed: 400: role "reporting" already exists'),
    );
    const res = await POST(bodyReq("POST", { name: "reporting", canLogin: true }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('role "reporting" already exists');
  });
});

describe("PATCH /api/console/roles (alter)", () => {
  test("existence-checks then alters with quoted identifier", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    const res = await PATCH(
      bodyReq("PATCH", {
        name: "reporting",
        canLogin: false,
        bypassRls: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "reporting" });
    expect(lastSql()).toBe('alter role "reporting" with NOLOGIN BYPASSRLS');
  });

  test("400 refusing a protected platform role — never reaches runQuery", async () => {
    const res = await PATCH(
      bodyReq("PATCH", { name: "service_role", isSuperuser: true }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("protected platform role"),
    });
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 refusing a pg_* predefined role", async () => {
    const res = await PATCH(
      bodyReq("PATCH", { name: "pg_read_all_data", canLogin: true }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 when the role does not exist", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    const res = await PATCH(bodyReq("PATCH", { name: "ghost", canLogin: true }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "role ghost does not exist",
    });
  });
});

describe("DELETE /api/console/roles (drop)", () => {
  test("existence-checks then drops with quoted identifier", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    const res = await DELETE(bodyReq("DELETE", { name: "reporting" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(lastSql()).toBe('drop role "reporting"');
  });

  test("400 refusing a protected platform role — never reaches runQuery", async () => {
    const res = await DELETE(bodyReq("DELETE", { name: "postgres" }));
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 on a missing field or invalid JSON — never reaches runQuery", async () => {
    expect((await DELETE(bodyReq("DELETE", {}))).status).toBe(400);
    expect((await DELETE(bodyReq("DELETE", "not json"))).status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});
