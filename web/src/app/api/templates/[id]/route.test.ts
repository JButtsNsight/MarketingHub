import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ getTemplate: vi.fn() }));

vi.mock("@/lib/templates/repo", () => ({
  getTemplate: h.getTemplate,
}));

import { GET } from "./route";

function oidcHeader(payload: Record<string, unknown>): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ typ: "JWT" })}.${seg(payload)}.sig`;
}

function marketingHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": oidcHeader({
      email: "amy@nsight.example",
      "cognito:groups": ["marketing"],
    }),
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/templates/[id]", () => {
  beforeEach(() => h.getTemplate.mockReset());

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
