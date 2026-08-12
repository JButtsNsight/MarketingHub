import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AppUser } from "@/lib/auth";

const h = vi.hoisted(() => ({
  user: null as { email: string; name: string; groups: string[] } | null,
  redirect: vi.fn((_url: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

// The page resolves identity server-side through getUser; stub it (settings
// page.test.tsx pattern) so these render tests focus on the three states.
// getUser itself is unit-tested in lib/auth.test.ts.
vi.mock("@/lib/auth", () => ({
  getUser: vi.fn(async (): Promise<AppUser | null> => h.user),
}));

// next/headers + next/navigation exist only inside a Next request scope; mock
// them (auth.test.ts pattern).
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: () => null }),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import LoginPage from "./page";

beforeEach(() => {
  h.user = null;
  h.redirect.mockClear();
});

describe("login landing (signed out)", () => {
  it("names the app and offers a Google SSO sign-in through the org front door", async () => {
    render(await LoginPage());
    expect(screen.getByText(/marketing hub/i)).toBeInTheDocument();
    // The wordmark stands alone — the Nsight element is gone everywhere.
    expect(screen.queryByText(/nsight/i)).toBeNull();
    // The link targets a PROTECTED route so the ALB re-triggers SSO; the old
    // href="/" just bounced back to this fallback.
    const link = screen.getByRole("link", { name: /sign in with google/i });
    expect(link).toHaveAttribute("href", "/overview");
  });

  it("renders the standalone dark SSO card (mirrors the Socrates auth screen)", async () => {
    const { container } = render(await LoginPage());
    expect(container.querySelector(".sso-screen")).not.toBeNull();
    expect(container.querySelector(".sso-card")).not.toBeNull();
  });
});

describe("login landing (signed in, NO access — awaiting access)", () => {
  beforeEach(() => {
    h.user = { email: "casey@nsightcare.com", name: "Casey", groups: [] };
  });

  it("names the user and says access is pending an admin grant", async () => {
    render(await LoginPage());
    expect(
      screen.getByText(
        /signed in as casey@nsightcare\.com — awaiting access\. ask an admin\./i,
      ),
    ).toBeInTheDocument();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it("offers sign-out and NO sign-in control (re-auth cannot grant a group)", async () => {
    render(await LoginPage());
    const signOut = screen.getByRole("link", { name: /sign out/i });
    expect(signOut).toHaveAttribute("href", "/logout");
    expect(
      screen.queryByRole("link", { name: /sign in with google/i }),
    ).toBeNull();
  });

  it("groups that grant NOTHING also render awaiting access — never a redirect", async () => {
    // A non-registry group must not count as access: /overview requires
    // `marketing` and would bounce right back here (redirect loop).
    h.user = { ...h.user!, groups: ["viewers"] };
    render(await LoginPage());
    expect(screen.getByText(/awaiting access/i)).toBeInTheDocument();
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe("login landing (signed in WITH access) — redirect targets a route the groups admit", () => {
  const casey = (groups: string[]) => ({
    email: "casey@nsightcare.com",
    name: "Casey",
    groups,
  });

  it("marketing goes to /overview — nothing to sign into here", async () => {
    h.user = casey(["marketing"]);
    await expect(LoginPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/overview");
  });

  it("a platform-only user goes to the section home, NOT /overview (which would 403-loop back here)", async () => {
    h.user = casey(["mh-section-platform"]);
    await expect(LoginPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/database");
  });

  it("an intel-only user goes to /intel", async () => {
    h.user = casey(["mh-section-intel"]);
    await expect(LoginPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/intel");
  });

  it("an admin without `marketing` lands on a section home (god-mode passes sections, not the marketing tier)", async () => {
    h.user = casey(["marketinghub-admins"]);
    await expect(LoginPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(h.redirect).toHaveBeenCalledWith("/database");
  });
});
