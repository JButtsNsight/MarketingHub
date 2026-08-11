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

import InfrastructurePage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

describe("infrastructure/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("renders the architecture reference behind the gate", async () => {
    render(await InfrastructurePage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Architecture", level: 1 }),
    ).toBeInTheDocument();
    // The reference sections are present (services table + posture list).
    expect(screen.getByRole("heading", { name: "Services" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Posture" })).toBeInTheDocument();
  });

  test("page is static reference — never fetches, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      render(await InfrastructurePage());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("signed-in non-admin gets the terse 403 panel, no content", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await InfrastructurePage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByText("Architecture")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(InfrastructurePage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
