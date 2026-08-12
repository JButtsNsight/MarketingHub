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
  listFunctions: vi.fn(),
  dropFunction: vi.fn(),
  runQuery: vi.fn(),
}));

vi.mock("@/lib/console/dbobjects", () => ({
  listFunctions: h.listFunctions,
  dropFunction: h.dropFunction,
}));
vi.mock("@/lib/console/pgmeta", () => ({
  runQuery: h.runQuery,
}));

import { DELETE, GET } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

const SAMPLE = [
  {
    oid: 1234,
    schema: "marketinghub",
    name: "touch_updated_at",
    identityArguments: "",
    arguments: "",
    returnType: "trigger",
    language: "plpgsql",
    kind: "function",
    securityDefiner: true,
  },
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
  h.listFunctions.mockResolvedValue(SAMPLE);
});

afterEach(() => {
  clearAlbEnv();
});

function getReq(query = "", headers: HeadersInit = { "x-amzn-oidc-data": platformToken }) {
  return new Request(`http://x/api/console/functions${query}`, { headers });
}

function deleteReq(
  body: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  },
) {
  return new Request("http://x/api/console/functions", {
    method: "DELETE",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/console/functions", () => {
  test("401/403 before anything runs", async () => {
    expect((await GET(getReq("", {}))).status).toBe(401);
    expect(
      (await GET(getReq("", { "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listFunctions).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (await GET(getReq("", { "x-amzn-oidc-data": marketingToken }))).status,
    ).toBe(403);
    expect(h.listFunctions).not.toHaveBeenCalled();
    expect(
      (await GET(getReq("", { "x-amzn-oidc-data": adminToken }))).status,
    ).toBe(200);
  });

  test("lists routines across the marketinghub/public/pgmq_public schemas", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ functions: SAMPLE });
    expect(h.listFunctions).toHaveBeenCalledWith([
      "marketinghub",
      "public",
      "pgmq_public",
    ]);
  });

  test("?oid=<n> returns that routine's definition", async () => {
    h.runQuery.mockResolvedValue([
      { definition: "CREATE FUNCTION ...", kind: "function" },
    ]);
    const res = await GET(getReq("?oid=1234"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      definition: "CREATE FUNCTION ...",
      kind: "function",
    });
    expect(h.listFunctions).not.toHaveBeenCalled();
  });

  test("aggregate/window routines report a null definition (not an error)", async () => {
    h.runQuery.mockResolvedValue([{ definition: null, kind: "aggregate" }]);
    const res = await GET(getReq("?oid=1234"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ definition: null, kind: "aggregate" });
  });

  test("404 when the oid matches no routine", async () => {
    h.runQuery.mockResolvedValue([]);
    const res = await GET(getReq("?oid=999999"));
    expect(res.status).toBe(404);
  });

  test("400 on a non-integer oid", async () => {
    const res = await GET(getReq("?oid=not-a-number"));
    expect(res.status).toBe(400);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/console/functions", () => {
  test("401/403 before anything runs", async () => {
    expect((await DELETE(deleteReq({ oid: 1 }, {}))).status).toBe(401);
    expect(
      (
        await DELETE(
          deleteReq(
            { oid: 1 },
            {
              "x-amzn-oidc-data": viewersToken,
              "content-type": "application/json",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(h.dropFunction).not.toHaveBeenCalled();
  });

  test("drops a function by oid", async () => {
    h.dropFunction.mockResolvedValue(undefined);
    const res = await DELETE(deleteReq({ oid: 1234 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dropped: true });
    expect(h.dropFunction).toHaveBeenCalledWith(1234);
  });

  test("a [console:dbobjects] failure surfaces as 400 with the bare message", async () => {
    h.dropFunction.mockRejectedValue(
      new Error(
        "[console:dbobjects] drop-function failed: function with oid 5 does not exist",
      ),
    );
    const res = await DELETE(deleteReq({ oid: 5 }));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "function with oid 5 does not exist",
    });
  });

  test("400 on malformed JSON or a missing oid", async () => {
    expect((await DELETE(deleteReq("{nope"))).status).toBe(400);
    expect((await DELETE(deleteReq({}))).status).toBe(400);
    expect(h.dropFunction).not.toHaveBeenCalled();
  });
});
