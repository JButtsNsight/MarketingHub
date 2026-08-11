import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireAdminUser: vi.fn(),
}));

// The page is gated server-side on the admin group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// auth.test.ts). Tests below verify the gate is enforced BEFORE any content
// renders, for both the signed-out and the non-admin outcome.
vi.mock("@/lib/requireAdminUser", () => ({
  requireAdminUser: h.requireAdminUser,
}));

import AuthPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

describe("admin/auth/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("renders the session + identity reference behind the gate", async () => {
    render(await AuthPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Identity & access", level: 1 }),
    ).toBeInTheDocument();
    // The session section renders the GATE's user — never a separate lookup.
    expect(screen.getByText("amy@nsight.example")).toBeInTheDocument();
    expect(screen.getAllByText("marketinghub-admins").length).toBeGreaterThan(0);
  });

  test("page is static reference — never fetches, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      render(await AuthPage());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("signed-in non-admin gets the terse 403 panel, no content", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await AuthPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByText("Identity & access")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(AuthPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
