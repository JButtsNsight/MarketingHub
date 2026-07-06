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

const h = vi.hoisted(() => ({ getTemplate: vi.fn() }));

vi.mock("@/lib/templates/repo", () => ({
  getTemplate: h.getTemplate,
}));

import { GET } from "./route";

let marketingToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["marketing"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.getTemplate.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/templates/[id]", () => {
  test("401 when unauthenticated", async () => {
    const req = new Request("http://x/api/templates/t1");
    const res = await GET(req, ctx("t1"));
    expect(res.status).toBe(401);
    expect(h.getTemplate).not.toHaveBeenCalled();
  });

  test("200 + template when found", async () => {
    h.getTemplate.mockResolvedValue({ id: "t1", name: "Spring Promo" });
    const req = new Request("http://x/api/templates/t1", {
      headers: marketingHeaders(),
    });
    const res = await GET(req, ctx("t1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template.id).toBe("t1");
    expect(h.getTemplate).toHaveBeenCalledWith("t1");
  });

  test("404 when not found", async () => {
    h.getTemplate.mockResolvedValue(null);
    const req = new Request("http://x/api/templates/missing", {
      headers: marketingHeaders(),
    });
    const res = await GET(req, ctx("missing"));
    expect(res.status).toBe(404);
  });
});
