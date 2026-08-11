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

// The client island fetches /api/console/gotrue/users on mount (its own tests
// cover that); stub it so the page test never issues a network call.
vi.mock("@/components/console/AuthUsersClient", () => ({
  AuthUsersClient: () => <div data-testid="auth-users-client" />,
}));

import AuthUsersPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

describe("admin/auth/users/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("mounts the users client behind the gate", async () => {
    render(await AuthUsersPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Users", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("auth-users-client")).toBeInTheDocument();
  });

  test("signed-in non-admin gets the terse 403 panel — client never mounts", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await AuthUsersPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByTestId("auth-users-client")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(AuthUsersPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
