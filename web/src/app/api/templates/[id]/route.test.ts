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

const h = vi.hoisted(() => ({ getTemplate: vi.fn(), updateTemplate: vi.fn() }));

vi.mock("@/lib/templates/repo", () => ({
  getTemplate: h.getTemplate,
  updateTemplate: h.updateTemplate,
}));

import { GET, PATCH } from "./route";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  h.updateTemplate.mockReset();
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
    const req = new Request(`http://x/api/templates/${T1}`);
    const res = await GET(req, ctx(T1));
    expect(res.status).toBe(401);
    expect(h.getTemplate).not.toHaveBeenCalled();
  });

  test("200 + template when found", async () => {
    h.getTemplate.mockResolvedValue({ id: T1, name: "Spring Promo" });
    const req = new Request(`http://x/api/templates/${T1}`, {
      headers: marketingHeaders(),
    });
    const res = await GET(req, ctx(T1));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template.id).toBe(T1);
    expect(h.getTemplate).toHaveBeenCalledWith(T1);
  });

  test("404 when not found", async () => {
    h.getTemplate.mockResolvedValue(null);
    const req = new Request(`http://x/api/templates/${T1}`, {
      headers: marketingHeaders(),
    });
    const res = await GET(req, ctx(T1));
    expect(res.status).toBe(404);
  });

  test("404 for a non-UUID id without touching the repo", async () => {
    const req = new Request("http://x/api/templates/not-a-uuid", {
      headers: marketingHeaders(),
    });
    const res = await GET(req, ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.getTemplate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/templates/[id]", () => {
  function patchReq(body: unknown, id: string = T1) {
    return new Request(`http://x/api/templates/${id}`, {
      method: "PATCH",
      headers: { ...marketingHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("401 when unauthenticated", async () => {
    const req = new Request(`http://x/api/templates/${T1}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "New" }),
    });
    const res = await PATCH(req, ctx(T1));
    expect(res.status).toBe(401);
    expect(h.updateTemplate).not.toHaveBeenCalled();
  });

  test("200 + updated template on a valid edit", async () => {
    h.updateTemplate.mockResolvedValue({ id: T1, name: "Renamed" });
    const res = await PATCH(patchReq({ name: "Renamed" }), ctx(T1));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.template.name).toBe("Renamed");
    expect(h.updateTemplate).toHaveBeenCalledWith(T1, { name: "Renamed" });
  });

  test("400 when no editable field is present", async () => {
    const res = await PATCH(patchReq({}), ctx(T1));
    expect(res.status).toBe(400);
    expect(h.updateTemplate).not.toHaveBeenCalled();
  });

  test("400 when a present field is blank", async () => {
    const res = await PATCH(patchReq({ name: "   " }), ctx(T1));
    expect(res.status).toBe(400);
    expect(h.updateTemplate).not.toHaveBeenCalled();
  });

  test("404 when the template does not exist", async () => {
    h.updateTemplate.mockResolvedValue(null);
    const res = await PATCH(patchReq({ name: "Renamed" }), ctx(T1));
    expect(res.status).toBe(404);
  });

  test("400 when blanking an email template's subject", async () => {
    h.updateTemplate.mockRejectedValue(
      new Error("[templates] update failed: subject is required for email templates"),
    );
    const res = await PATCH(patchReq({ subject: "" }), ctx(T1));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/subject is required/i);
  });
});
