import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  headerValue: null as string | null,
  redirect: vi.fn((_url: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "x-amzn-oidc-data" ? h.headerValue : null,
    }),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import { requireMarketingUser } from "./requireMarketingUser";

/** Build a minimal ALB `x-amzn-oidc-data` JWT with the given claims. */
function oidcToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.sig`;
}

describe("requireMarketingUser (page gate)", () => {
  beforeEach(() => {
    h.headerValue = null;
    h.redirect.mockClear();
  });

  test("returns the user when they are in the marketing group", async () => {
    h.headerValue = oidcToken({
      email: "amy@nsight.example",
      "cognito:groups": ["marketing"],
    });
    const user = await requireMarketingUser();
    expect(user.email).toBe("amy@nsight.example");
    expect(h.redirect).not.toHaveBeenCalled();
  });

  test("redirects to /login when authenticated but NOT in the marketing group", async () => {
    h.headerValue = oidcToken({
      email: "bob@nsight.example",
      "cognito:groups": ["viewers"],
    });
    await expect(requireMarketingUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });

  test("redirects to /login when unauthenticated (no header)", async () => {
    h.headerValue = null;
    await expect(requireMarketingUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/login");
  });
});
