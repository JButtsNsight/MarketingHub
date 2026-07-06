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

// Mock the server-only repo; the route is the unit under test.
const h = vi.hoisted(() => ({
  createTemplate: vi.fn(),
  listTemplates: vi.fn(),
  searchTemplates: vi.fn(),
}));

vi.mock("@/lib/templates/repo", () => ({
  createTemplate: h.createTemplate,
  listTemplates: h.listTemplates,
  searchTemplates: h.searchTemplates,
}));

import { GET, POST } from "./route";

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
  h.createTemplate.mockReset();
  h.listTemplates.mockReset();
  h.searchTemplates.mockReset();
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

const validBody = {
  name: "Spring Promo",
  type: "text",
  category: "Promotion",
  tags: ["sale"],
  body: "Big sale this spring",
};

describe("POST /api/templates", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const req = new Request("http://x/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(h.createTemplate).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const req = new Request("http://x/api/templates", {
      method: "POST",
      headers: {
        "x-amzn-oidc-data": viewersToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(h.createTemplate).not.toHaveBeenCalled();
  });

  test("400 when the body fails zod validation", async () => {
    const req = new Request("http://x/api/templates", {
      method: "POST",
      headers: marketingHeaders(),
      body: JSON.stringify({ ...validBody, type: "sms" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(h.createTemplate).not.toHaveBeenCalled();
  });

  test("201 + id when a marketing user submits a valid template", async () => {
    h.createTemplate.mockResolvedValue({ id: "new-id", ...validBody });
    const req = new Request("http://x/api/templates", {
      method: "POST",
      headers: marketingHeaders(),
      body: JSON.stringify(validBody),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("new-id");
    // created_by is stamped from the authed user's email
    expect(h.createTemplate).toHaveBeenCalledTimes(1);
    expect(h.createTemplate.mock.calls[0][1]).toMatchObject({
      email: "amy@nsight.example",
    });
  });

  test("passes an uploaded file through to Storage when a filename is present", async () => {
    h.createTemplate.mockResolvedValue({ id: "new-id", ...validBody });
    const req = new Request("http://x/api/templates", {
      method: "POST",
      headers: marketingHeaders(),
      body: JSON.stringify({
        ...validBody,
        type: "email",
        subject: "Hi",
        body: "<h1>Hi</h1>",
        filename: "welcome.html",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const file = h.createTemplate.mock.calls[0][2];
    expect(file).toMatchObject({
      filename: "welcome.html",
      content: "<h1>Hi</h1>",
      contentType: "text/html",
    });
  });
});

describe("GET /api/templates", () => {
  test("401 when unauthenticated", async () => {
    const req = new Request("http://x/api/templates");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  test("lists (no q) with category/type filters applied", async () => {
    h.listTemplates.mockResolvedValue([{ id: "a" }]);
    const req = new Request(
      "http://x/api/templates?category=Promotion&type=email",
      { headers: marketingHeaders() },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toEqual([{ id: "a" }]);
    expect(h.listTemplates).toHaveBeenCalledWith({
      category: "Promotion",
      type: "email",
    });
    expect(h.searchTemplates).not.toHaveBeenCalled();
  });

  test("searches when q is present, passing filters through", async () => {
    h.searchTemplates.mockResolvedValue([{ id: "b" }]);
    const req = new Request(
      "http://x/api/templates?q=spring+sale&category=Promotion",
      { headers: marketingHeaders() },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toEqual([{ id: "b" }]);
    expect(h.searchTemplates).toHaveBeenCalledWith("spring sale", {
      category: "Promotion",
      type: undefined,
    });
  });

  test("ignores an invalid type filter value", async () => {
    h.listTemplates.mockResolvedValue([]);
    const req = new Request("http://x/api/templates?type=bogus", {
      headers: marketingHeaders(),
    });
    await GET(req);
    expect(h.listTemplates).toHaveBeenCalledWith({
      category: undefined,
      type: undefined,
    });
  });
});
