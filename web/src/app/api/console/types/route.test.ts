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
  listEnumTypes: vi.fn(),
  addEnumValue: vi.fn(),
  runQuery: vi.fn(),
}));

// Keep OBJECT_SCHEMAS + identifiers validation real; stub only the DB readers.
vi.mock("@/lib/console/dbobjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/dbobjects")>();
  return {
    ...actual,
    listEnumTypes: h.listEnumTypes,
    addEnumValue: h.addEnumValue,
  };
});
vi.mock("@/lib/console/pgmeta", () => ({
  runQuery: h.runQuery,
}));

import { DELETE, GET, PATCH, POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

const TYPES = [
  { schema: "public", name: "color", values: ["red", "green"] },
  { schema: "marketinghub", name: "channel", values: ["sms", "email"] },
];

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
  for (const fn of Object.values(h)) fn.mockReset();
  h.listEnumTypes.mockResolvedValue(TYPES);
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
  return new Request("http://x/api/console/types", { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = sectionHeaders(),
) {
  return new Request("http://x/api/console/types", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The SQL of the last runQuery call. */
function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

describe("GET /api/console/types", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq({}))).status).toBe(401);
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listEnumTypes).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": marketingToken }))).status,
    ).toBe(403);
    expect(h.listEnumTypes).not.toHaveBeenCalled();
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": adminToken }))).status,
    ).toBe(200);
  });

  test("returns the enum type list", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ types: TYPES });
  });
});

describe("POST /api/console/types (create)", () => {
  test("401/403 before any DDL", async () => {
    expect((await POST(bodyReq("POST", {}, {}))).status).toBe(401);
    expect(
      (
        await POST(
          bodyReq(
            "POST",
            { schema: "public", name: "color", values: ["red"] },
            { "x-amzn-oidc-data": viewersToken },
          ),
        )
      ).status,
    ).toBe(403);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("201 builds a parameterized CREATE TYPE after existence checks", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // schema exists
      .mockResolvedValueOnce([{ found: false }]) // type not yet defined
      .mockResolvedValueOnce([]); // create
    const res = await POST(
      bodyReq("POST", {
        schema: "public",
        name: "color",
        values: ["red", "green"],
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      created: { schema: "public", name: "color" },
    });
    expect(lastSql()).toBe(
      `create type "public"."color" as enum ('red', 'green')`,
    );
  });

  test("400 when the type already exists", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // schema exists
      .mockResolvedValueOnce([{ found: true }]); // type already exists
    const res = await POST(
      bodyReq("POST", { schema: "public", name: "color", values: ["red"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /already exists/,
    );
  });

  test("400 on an invalid type name — no SQL is built", async () => {
    const res = await POST(
      bodyReq("POST", { schema: "public", name: "1bad", values: ["red"] }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 on a schema outside the surfaced set — no SQL is built", async () => {
    const res = await POST(
      bodyReq("POST", { schema: "pg_catalog", name: "color", values: ["red"] }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("400 on validation failure (no values)", async () => {
    const res = await POST(
      bodyReq("POST", { schema: "public", name: "color", values: [] }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/console/types (add value)", () => {
  test("delegates to the foundation addEnumValue", async () => {
    h.addEnumValue.mockResolvedValue(undefined);
    const res = await PATCH(
      bodyReq("PATCH", { schema: "public", name: "color", value: "blue" }),
    );
    expect(res.status).toBe(200);
    expect(h.addEnumValue).toHaveBeenCalledWith("public", "color", "blue");
    expect(await res.json()).toEqual({
      added: { schema: "public", name: "color", value: "blue" },
    });
  });

  test("maps a [console:dbobjects] failure to a 400 with the bare message", async () => {
    h.addEnumValue.mockRejectedValue(
      new Error(
        "[console:dbobjects] add-enum-value failed: enum type public.color does not exist",
      ),
    );
    const res = await PATCH(
      bodyReq("PATCH", { schema: "public", name: "color", value: "blue" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "enum type public.color does not exist",
    );
  });

  test("403 for a user without the section before any write", async () => {
    const res = await PATCH(
      bodyReq(
        "PATCH",
        { schema: "public", name: "color", value: "blue" },
        { "x-amzn-oidc-data": viewersToken },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.addEnumValue).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/console/types (drop)", () => {
  test("drops after an existence check", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // enum type exists
      .mockResolvedValueOnce([]); // drop
    const res = await DELETE(
      bodyReq("DELETE", { schema: "public", name: "color" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dropped: { schema: "public", name: "color" },
    });
    expect(lastSql()).toBe(`drop type "public"."color"`);
  });

  test("400 when the enum type does not exist", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    const res = await DELETE(
      bodyReq("DELETE", { schema: "public", name: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /does not exist/,
    );
  });

  test("400 on a schema outside the surfaced set — no SQL is built", async () => {
    const res = await DELETE(
      bodyReq("DELETE", { schema: "pg_catalog", name: "color" }),
    );
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});
