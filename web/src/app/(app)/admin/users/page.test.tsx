import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireAdminUser: vi.fn(),
}));

// The page is gated server-side on the admin group (live pool check); stub the
// gate so the render tests focus on the page body (the gate itself is
// unit-tested in auth.test.ts). Tests below verify the gate is enforced BEFORE
// any content renders, for both the signed-out and the non-admin outcome.
vi.mock("@/lib/requireAdminUser", () => ({
  requireAdminUser: h.requireAdminUser,
}));

// The client island fetches /api/console/cognito/users on mount (its own tests
// cover that); stub it so the page test never issues a network call.
const usersRoles = vi.hoisted(() => ({
  props: [] as unknown[],
}));
vi.mock("@/components/admin/UsersRoles", () => ({
  UsersRoles: (props: unknown) => {
    usersRoles.props.push(props);
    return <div data-testid="users-roles" />;
  },
}));

import AdminUsersPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

describe("admin/users/page.tsx (server component)", () => {
  beforeEach(() => {
    usersRoles.props.length = 0;
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("mounts the roles client behind the gate with the actor's email", async () => {
    render(await AdminUsersPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Users & Roles", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("users-roles")).toBeInTheDocument();
    // The lockout UX needs to know who is acting.
    expect(usersRoles.props[0]).toEqual({ currentEmail: "amy@nsight.example" });
  });

  test("signed-in non-admin gets the terse 403 panel — client never mounts", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await AdminUsersPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByTestId("users-roles")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(AdminUsersPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
