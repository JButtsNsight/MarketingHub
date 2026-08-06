// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  getLinkTarget: vi.fn(),
  recordLinkClick: vi.fn(),
}));

vi.mock("@/lib/sms/repo", () => ({
  getLinkTarget: h.getLinkTarget,
  recordLinkClick: h.recordLinkClick,
}));

import { GET } from "./route";

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function reqWith(userAgent?: string): Request {
  return new Request("https://mh.example.com/l/abcd1234", {
    headers: userAgent ? { "user-agent": userAgent } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recordLinkClick.mockResolvedValue(undefined);
});

describe("GET /l/[slug]", () => {
  test("404s a malformed slug without touching storage", async () => {
    const res = await GET(reqWith(), ctx("../../etc/passwd"));
    expect(res.status).toBe(404);
    expect(h.getLinkTarget).not.toHaveBeenCalled();
    expect(h.recordLinkClick).not.toHaveBeenCalled();
  });

  test("404s an unknown slug and records no click", async () => {
    h.getLinkTarget.mockResolvedValue(null);
    const res = await GET(reqWith(), ctx("unknown1"));
    expect(res.status).toBe(404);
    expect(h.recordLinkClick).not.toHaveBeenCalled();
  });

  test("302s to the target and records the click with the user agent", async () => {
    h.getLinkTarget.mockResolvedValue({
      id: "link-1",
      target_url: "https://book.example.com/slots",
    });

    const res = await GET(reqWith("TestAgent/1.0"), ctx("abcd1234"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://book.example.com/slots");
    expect(h.getLinkTarget).toHaveBeenCalledWith("abcd1234");
    expect(h.recordLinkClick).toHaveBeenCalledWith("link-1", "TestAgent/1.0");
  });

  test("still redirects when click recording fails (best-effort)", async () => {
    h.getLinkTarget.mockResolvedValue({
      id: "link-1",
      target_url: "https://book.example.com/slots",
    });
    h.recordLinkClick.mockRejectedValue(new Error("db hiccup"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await GET(reqWith(), ctx("abcd1234"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://book.example.com/slots");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("passes a null user agent through when the header is absent", async () => {
    h.getLinkTarget.mockResolvedValue({
      id: "link-1",
      target_url: "https://book.example.com/slots",
    });

    await GET(reqWith(), ctx("abcd1234"));

    expect(h.recordLinkClick).toHaveBeenCalledWith("link-1", null);
  });
});
