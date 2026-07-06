import { describe, it, expect, vi, beforeEach } from "vitest";

const redirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirect(url),
}));

beforeEach(() => {
  redirect.mockClear();
});

describe("Home page", () => {
  it("redirects to /templates", async () => {
    const mod = await import("./page");
    mod.default();
    expect(redirect).toHaveBeenCalledWith("/templates");
  });
});
