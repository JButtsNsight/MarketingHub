// @vitest-environment node
// The route runs the verified (jose ES256) ALB auth path; node env avoids the
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

// Mock the snippet repo; the route (validation + the platform gate) is the
// unit under test. Saved snippets feed the RUN-able SQL editor, so the gate
// matrix here pins the section boundary like every other sectioned route.
const h = vi.hoisted(() => ({ listSnippets: vi.fn(), createSnippet: vi.fn() }));

vi.mock("@/lib/console/sql", () => ({
  listSnippets: h.listSnippets,
  createSnippet: h.createSnippet,
}));

import { GET, POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;

const SNIPPET = {
  id: "8b2f1a4e-0000-4000-8000-000000000000",
  name: "recent sends",
  sql: "select 1",
  created_by: "amy@nsight.example",
};

beforeAll(async () => {
  await initAlbKeys();
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing", "mh-section-platform"],
  });
  marketingToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.listSnippets.mockReset().mockResolvedValue([SNIPPET]);
  h.createSnippet.mockReset().mockResolvedValue(SNIPPET);
});

afterEach(() => {
  clearAlbEnv();
});

function get(headers: HeadersInit = { "x-amzn-oidc-data": platformToken }) {
  return GET(new Request("http://x/api/console/snippets", { headers }));
}

function post(
  body: unknown,
  headers: HeadersInit = { "x-amzn-oidc-data": platformToken },
) {
  return POST(
    new Request("http://x/api/console/snippets", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("/api/console/snippets — platform section gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    expect((await GET(new Request("http://x/api/console/snippets"))).status).toBe(401);
    const res = await POST(
      new Request("http://x/api/console/snippets", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(h.listSnippets).not.toHaveBeenCalled();
    expect(h.createSnippet).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section — read AND write; admins pass", async () => {
    const marketing = { "x-amzn-oidc-data": marketingToken };
    expect((await get(marketing)).status).toBe(403);
    expect((await post({ name: "n", sql: "select 1" }, marketing)).status).toBe(403);
    expect(h.listSnippets).not.toHaveBeenCalled();
    expect(h.createSnippet).not.toHaveBeenCalled();

    const admin = { "x-amzn-oidc-data": adminToken };
    expect((await get(admin)).status).toBe(200);
    expect((await post({ name: "n", sql: "select 1" }, admin)).status).toBe(201);
  });
});

describe("GET /api/console/snippets", () => {
  test("200 lists the saved snippets", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snippets: [SNIPPET] });
  });
});

describe("POST /api/console/snippets", () => {
  test("400 on invalid JSON", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  test("400 when name or sql is missing/blank — nothing created", async () => {
    expect((await post({ name: "  ", sql: "select 1" })).status).toBe(400);
    expect((await post({ name: "n" })).status).toBe(400);
    expect(h.createSnippet).not.toHaveBeenCalled();
  });

  test("201 creates the snippet attributed to the caller", async () => {
    const res = await post({ name: "recent sends", sql: "select 1" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ snippet: SNIPPET });
    expect(h.createSnippet).toHaveBeenCalledWith(
      "recent sends",
      "select 1",
      "amy@nsight.example",
    );
  });
});
