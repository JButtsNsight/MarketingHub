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

// The client island drives /api/console/impersonate (its own tests cover
// that); stub it so the page test never issues a network call.
vi.mock("./ImpersonateClient", () => ({
  ImpersonateClient: () => <div data-testid="impersonate-client" />,
}));

import ImpersonatePage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

describe("admin/auth/impersonate/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("mounts the impersonation client behind the gate", async () => {
    render(await ImpersonatePage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "User impersonation", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("impersonate-client")).toBeInTheDocument();
  });

  test("signed-in non-admin gets the terse 403 panel — client never mounts", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await ImpersonatePage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByTestId("impersonate-client")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(ImpersonatePage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
