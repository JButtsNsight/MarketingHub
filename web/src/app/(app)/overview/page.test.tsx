import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
  getUserClient: vi.fn(),
  getTemplateStats: vi.fn(),
  listBucket: vi.fn(),
  listCampaignsWithCounts: vi.fn(),
  getEngagementForCampaigns: vi.fn(),
  countUnhandledInbound: vi.fn(),
  countSuppressions: vi.fn(),
}));

// The page is gated server-side on the marketing group; stub the gate and the
// data fan-out so these render tests focus on the Explore-card filtering (the
// four admin jump-to cards must never be advertised to non-admins — the routes
// themselves stay the enforcement, tested per page).
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
vi.mock("@/lib/supabase", () => ({ getUserClient: h.getUserClient }));
vi.mock("@/lib/console/stats", () => ({ getTemplateStats: h.getTemplateStats }));
vi.mock("@/lib/console/storage", () => ({ listBucket: h.listBucket }));
vi.mock("@/lib/sms/repo", () => ({
  listCampaignsWithCounts: h.listCampaignsWithCounts,
  getEngagementForCampaigns: h.getEngagementForCampaigns,
  countUnhandledInbound: h.countUnhandledInbound,
  countSuppressions: h.countSuppressions,
}));

import OverviewPage from "./page";

const MEMBER = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing"],
};
const PLATFORM_MEMBER = {
  ...MEMBER,
  groups: ["marketing", "mh-section-platform"],
};
const ADMIN = { ...MEMBER, groups: ["marketing", "marketinghub-admins"] };

const ADMIN_CARDS = [
  "Authentication",
  "Advisors",
  "Cloud",
  "Infrastructure",
] as const;

describe("overview/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireMarketingUser.mockReset().mockResolvedValue(MEMBER);
    h.getUserClient.mockReset().mockResolvedValue({});
    h.getTemplateStats.mockReset().mockResolvedValue({
      total: 0,
      byType: [],
      byCategory: [],
      latest: null,
    });
    h.listBucket.mockReset().mockResolvedValue([]);
    h.listCampaignsWithCounts.mockReset().mockResolvedValue([]);
    h.getEngagementForCampaigns.mockReset().mockResolvedValue(new Map());
    h.countUnhandledInbound.mockReset().mockResolvedValue(0);
    h.countSuppressions.mockReset().mockResolvedValue(0);
  });

  test("admin sees the Explore section with all four admin jump-to cards", async () => {
    h.requireMarketingUser.mockResolvedValue(ADMIN);
    render(await OverviewPage());

    expect(screen.getByText("Jump to a section")).toBeInTheDocument();
    for (const card of ADMIN_CARDS) {
      expect(screen.getByText(card)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("link", { name: /Authentication/ }),
    ).toHaveAttribute("href", "/admin/auth");
  });

  test("non-admin never sees the Explore cards — no advertised 403s", async () => {
    render(await OverviewPage());

    // The marketing surfaces still render...
    expect(
      screen.getByRole("heading", { name: "Overview", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Recent campaigns")).toBeInTheDocument();
    // ...but nothing links to an admin-gated route.
    expect(screen.queryByText("Jump to a section")).not.toBeInTheDocument();
    for (const card of ADMIN_CARDS) {
      expect(screen.queryByText(card)).not.toBeInTheDocument();
    }
    const links = screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).not.toContain("/admin/auth");
    expect(links).not.toContain("/admin/advisors");
    expect(links).not.toContain("/admin/cloud");
    expect(links).not.toContain("/infrastructure");
  });

  test("marketing-only user gets no Storage section — /storage is platform-gated now", async () => {
    render(await OverviewPage());

    expect(screen.queryByText("Storage")).not.toBeInTheDocument();
    const links = screen.queryAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).not.toContain("/storage");
    // No bucket fan-out for a user whose role can't open the surface.
    expect(h.listBucket).not.toHaveBeenCalled();
  });

  test("platform section restores the Storage section (admins too, via god-mode)", async () => {
    h.requireMarketingUser.mockResolvedValue(PLATFORM_MEMBER);
    render(await OverviewPage());

    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/storage",
    );
    expect(h.listBucket).toHaveBeenCalledTimes(1);
  });
});
