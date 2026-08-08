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
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  alterPolicy: vi.fn(),
  dropPolicy: vi.fn(),
  listEditorTables: vi.fn(),
}));

// The DDL assembly lives in the foundation policies lib; the route only gates,
// validates, and maps errors — so mock the lib mutators (and the table reader)
// to observe the calls and simulate Postgres failures. POLICY_COMMANDS /
// POLICY_ACTIONS stay real (the zod schemas read them at module load).
vi.mock("@/lib/console/policies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/policies")>();
  return {
    ...actual,
    listPolicies: h.listPolicies,
    createPolicy: h.createPolicy,
    alterPolicy: h.alterPolicy,
    dropPolicy: h.dropPolicy,
  };
});

vi.mock("@/lib/console/tables", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/tables")>();
  return { ...actual, listEditorTables: h.listEditorTables };
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

const POLICY = {
  id: 1,
  schema: "public",
  table: "widgets",
  name: "widgets_admin",
  action: "PERMISSIVE",
  roles: ["service_role"],
  command: "ALL",
  definition: "true",
  check: null,
};

const TABLE = {
  schema: "public",
  name: "widgets",
  rlsEnabled: true,
  // listEditorTables returns richer rows; the route reads only these three.
  columns: [],
  primaryKeys: [],
};

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.listPolicies.mockReset();
  h.createPolicy.mockReset();
  h.alterPolicy.mockReset();
  h.dropPolicy.mockReset();
  h.listEditorTables.mockReset();
  h.listPolicies.mockResolvedValue([POLICY]);
  h.listEditorTables.mockResolvedValue([TABLE]);
  h.createPolicy.mockResolvedValue(undefined);
  h.alterPolicy.mockResolvedValue(undefined);
  h.dropPolicy.mockResolvedValue(undefined);
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

function getReq(headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/console/policies", { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = marketingHeaders(),
) {
  return new Request("http://x/api/console/policies", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/console/policies", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq({}))).status).toBe(401);
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listPolicies).not.toHaveBeenCalled();
    expect(h.listEditorTables).not.toHaveBeenCalled();
  });

  test("200 returns policies + mapped tables", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policies: [POLICY],
      tables: [{ schema: "public", name: "widgets", rlsEnabled: true }],
    });
  });
});

describe("POST /api/console/policies (create)", () => {
  test("403 for a non-marketing user before any write", async () => {
    const res = await POST(
      bodyReq(
        "POST",
        { schema: "public", table: "widgets", name: "p1" },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.createPolicy).not.toHaveBeenCalled();
  });

  test("400 on an invalid identifier — never reaches createPolicy", async () => {
    const res = await POST(
      bodyReq("POST", { schema: "public", table: "widgets", name: "bad name" }),
    );
    expect(res.status).toBe(400);
    expect(h.createPolicy).not.toHaveBeenCalled();
  });

  test("400 on an empty USING expression — never reaches createPolicy", async () => {
    const res = await POST(
      bodyReq("POST", {
        schema: "public",
        table: "widgets",
        name: "p1",
        using: "",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.createPolicy).not.toHaveBeenCalled();
  });

  test("201 forwards a validated input to createPolicy", async () => {
    const res = await POST(
      bodyReq("POST", {
        schema: "public",
        table: "widgets",
        name: "p1",
        command: "SELECT",
        roles: ["service_role"],
        using: "true",
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: "p1" });
    expect(h.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "public",
        table: "widgets",
        name: "p1",
        command: "SELECT",
        roles: ["service_role"],
        using: "true",
        check: null,
      }),
    );
  });

  test("400 with the real Postgres message when the lib throws", async () => {
    h.createPolicy.mockRejectedValue(
      new Error(
        '[console:policies] create-policy failed: policy "p1" for table "widgets" already exists',
      ),
    );
    const res = await POST(
      bodyReq("POST", { schema: "public", table: "widgets", name: "p1" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'policy "p1" for table "widgets" already exists',
    });
  });
});

describe("PATCH /api/console/policies (alter)", () => {
  test("200 forwards roles + rename to alterPolicy", async () => {
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "public",
        table: "widgets",
        name: "widgets_admin",
        newName: "widgets_rw",
        roles: ["authenticated"],
        using: "(select auth.uid()) = user_id",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ altered: "widgets_rw" });
    expect(h.alterPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "public",
        table: "widgets",
        name: "widgets_admin",
        newName: "widgets_rw",
        roles: ["authenticated"],
        using: "(select auth.uid()) = user_id",
      }),
    );
  });

  test("400 when no change is provided — never reaches alterPolicy", async () => {
    const res = await PATCH(
      bodyReq("PATCH", { schema: "public", table: "widgets", name: "widgets_admin" }),
    );
    expect(res.status).toBe(400);
    expect(h.alterPolicy).not.toHaveBeenCalled();
  });

  test("400 with the real Postgres message when the lib throws", async () => {
    h.alterPolicy.mockRejectedValue(
      new Error(
        "[console:policies] alter-policy failed: policy ghost on public.widgets does not exist",
      ),
    );
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "public",
        table: "widgets",
        name: "ghost",
        roles: ["authenticated"],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "policy ghost on public.widgets does not exist",
    });
  });
});

describe("DELETE /api/console/policies (drop)", () => {
  test("200 forwards to dropPolicy", async () => {
    const res = await DELETE(
      bodyReq("DELETE", {
        schema: "public",
        table: "widgets",
        name: "widgets_admin",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dropped: "widgets_admin" });
    expect(h.dropPolicy).toHaveBeenCalledWith("public", "widgets", "widgets_admin");
  });

  test("400 on a missing field or invalid JSON — never reaches dropPolicy", async () => {
    expect((await DELETE(bodyReq("DELETE", { schema: "public" }))).status).toBe(400);
    expect((await DELETE(bodyReq("DELETE", "not json"))).status).toBe(400);
    expect(h.dropPolicy).not.toHaveBeenCalled();
  });
});
