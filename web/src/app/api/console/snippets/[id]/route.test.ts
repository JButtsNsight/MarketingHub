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

// Mock the snippet repo; the route (uuid guard + the platform gate) is the
// unit under test — the gate matrix pins the section boundary.
const h = vi.hoisted(() => ({ updateSnippet: vi.fn(), deleteSnippet: vi.fn() }));

vi.mock("@/lib/console/sql", () => ({
  updateSnippet: h.updateSnippet,
  deleteSnippet: h.deleteSnippet,
}));

import { DELETE, PATCH } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;

const ID = "8b2f1a4e-0000-4000-8000-000000000000";

const SNIPPET = {
  id: ID,
  name: "renamed",
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
  h.updateSnippet.mockReset().mockResolvedValue(SNIPPET);
  h.deleteSnippet.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  clearAlbEnv();
});

function patch(
  id: string,
  body: unknown,
  headers: HeadersInit = { "x-amzn-oidc-data": platformToken },
) {
  return PATCH(
    new Request(`http://x/api/console/snippets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function del(
  id: string,
  headers: HeadersInit = { "x-amzn-oidc-data": platformToken },
) {
  return DELETE(
    new Request(`http://x/api/console/snippets/${id}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("/api/console/snippets/[id] — platform section gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    expect((await patch(ID, { name: "x" }, {})).status).toBe(401);
    expect((await del(ID, {})).status).toBe(401);
    expect(h.updateSnippet).not.toHaveBeenCalled();
    expect(h.deleteSnippet).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section — update AND delete; admins pass", async () => {
    const marketing = { "x-amzn-oidc-data": marketingToken };
    expect((await patch(ID, { name: "x" }, marketing)).status).toBe(403);
    expect((await del(ID, marketing)).status).toBe(403);
    expect(h.updateSnippet).not.toHaveBeenCalled();
    expect(h.deleteSnippet).not.toHaveBeenCalled();

    const admin = { "x-amzn-oidc-data": adminToken };
    expect((await patch(ID, { name: "x" }, admin)).status).toBe(200);
    expect((await del(ID, admin)).status).toBe(204);
  });
});

describe("PATCH /api/console/snippets/[id]", () => {
  test("404 on a non-UUID id, before any repo call", async () => {
    const res = await patch("not-a-uuid", { name: "x" });
    expect(res.status).toBe(404);
    expect(h.updateSnippet).not.toHaveBeenCalled();
  });

  test("400 on invalid JSON and on an empty patch", async () => {
    expect((await patch(ID, "{nope")).status).toBe(400);
    expect((await patch(ID, {})).status).toBe(400);
    expect(h.updateSnippet).not.toHaveBeenCalled();
  });

  test("200 updates and echoes the snippet", async () => {
    const res = await patch(ID, { name: "renamed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ snippet: SNIPPET });
    expect(h.updateSnippet).toHaveBeenCalledWith(ID, { name: "renamed" });
  });

  test("404 when the repo finds no such snippet", async () => {
    h.updateSnippet.mockResolvedValue(null);
    expect((await patch(ID, { name: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/console/snippets/[id]", () => {
  test("404 on a non-UUID id, before any repo call", async () => {
    const res = await del("not-a-uuid");
    expect(res.status).toBe(404);
    expect(h.deleteSnippet).not.toHaveBeenCalled();
  });

  test("204 on removal; 404 when nothing was removed", async () => {
    expect((await del(ID)).status).toBe(204);
    expect(h.deleteSnippet).toHaveBeenCalledWith(ID);
    h.deleteSnippet.mockResolvedValue(false);
    expect((await del(ID)).status).toBe(404);
  });
});
