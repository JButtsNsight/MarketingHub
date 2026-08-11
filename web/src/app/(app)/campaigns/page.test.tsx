import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CampaignWithCounts, CountsByStatus } from "@/lib/sms/repo";
import { RECIPIENT_STATUSES, type CampaignStatus } from "@/lib/sms/schema";

const h = vi.hoisted(() => ({
  listCampaignsWithCounts: vi.fn(),
  getExplicitZoneCounts: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/sms/repo", () => ({
  listCampaignsWithCounts: h.listCampaignsWithCounts,
}));
// Only the DB aggregate is stubbed — the fold/chip helpers stay real.
vi.mock("@/lib/sms/zoneStats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/zoneStats")>()),
  getExplicitZoneCounts: h.getExplicitZoneCounts,
}));
// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the page body.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

import CampaignsPage from "./page";

function counts(partial: Partial<CountsByStatus> = {}): CountsByStatus {
  const zero = Object.fromEntries(
    RECIPIENT_STATUSES.map((s) => [s, 0]),
  ) as CountsByStatus;
  return { ...zero, ...partial };
}

function campaign(
  id: string,
  name: string,
  status: CampaignStatus,
  c: Partial<CountsByStatus> = {},
): CampaignWithCounts {
  return {
    id,
    name,
    template_id: "11111111-1111-4111-8111-111111111111",
    contact_list_id: null,
    monday_board_id: "4567890123",
    monday_phone_column_id: "phone",
    message_body: "Hi {{firstName}}",
    send_date: "2026-08-03",
    send_time: "11:30",
    send_timezone: "America/New_York",
    send_at: "2026-08-03T15:30:00Z",
    status,
    created_by: "amy@nsight.example",
    created_at: "2026-07-22T12:00:00Z",
    updated_at: "2026-07-22T12:00:00Z",
    counts: counts(c),
  };
}

describe("campaigns/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listCampaignsWithCounts.mockReset();
    h.getExplicitZoneCounts.mockReset().mockResolvedValue(new Map());
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("enforces the marketing group gate before reading campaigns", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([]);
    render(await CampaignsPage());
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("renders each campaign as a link to its detail page", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([
      campaign("c1", "August recall", "scheduled"),
    ]);
    render(await CampaignsPage());
    expect(
      screen.getByRole("link", { name: /august recall/i }),
    ).toHaveAttribute("href", "/campaigns/c1");
  });

  test("shows the status badge and the mono send date + 11:30 AM ET", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([
      campaign("c1", "August recall", "paused"),
    ]);
    render(await CampaignsPage());
    expect(screen.getByText("paused")).toBeInTheDocument();
    const send = screen.getByText(/2026-08-03/);
    expect(send).toHaveTextContent(/11:30 AM ET/);
    expect(send.closest(".mono, td.mono")).not.toBeNull();
  });

  test("shows total / sent / delivered / failed(+ambiguous) recipient counts", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([
      campaign("c1", "August recall", "sending", {
        pending: 3,
        sent: 5,
        delivered: 4,
        failed: 2,
        failed_ambiguous: 1,
        skipped: 1,
      }),
    ]);
    render(await CampaignsPage());
    const row = screen.getByRole("link", { name: /august recall/i }).closest("tr")!;
    const cells = Array.from(row.querySelectorAll("td")).map(
      (td) => td.textContent,
    );
    expect(cells).toContain("16"); // total = every outbox row
    expect(cells).toContain("5"); // sent
    expect(cells).toContain("4"); // delivered
    expect(cells).toContain("3"); // failed = failed + failed_ambiguous
  });

  test("a multi-zone campaign gets one N-zones chip in the sends column", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([
      campaign("c1", "August recall", "scheduled", { pending: 12, skipped: 4 }),
      campaign("c2", "Single zone", "scheduled", { pending: 5 }),
    ]);
    // c1: 4 explicit CT rows + 12 fallback rows in the campaign zone (ET).
    h.getExplicitZoneCounts.mockResolvedValue(
      new Map([["c1", new Map([["America/Chicago", 4]])]]),
    );
    render(await CampaignsPage());

    expect(h.getExplicitZoneCounts).toHaveBeenCalledWith(["c1", "c2"], h.userDb);
    const chip = screen.getByText("2 zones");
    expect(chip).toHaveAttribute("title", "ET 12 · CT 4");
    // The single-zone campaign gets none.
    expect(screen.getAllByText(/\d+ zones/)).toHaveLength(1);
  });

  test("header count and a New campaign action link", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([
      campaign("c1", "A", "scheduled"),
      campaign("c2", "B", "completed"),
    ]);
    render(await CampaignsPage());
    expect(screen.getByText(/2 total/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /new campaign/i }),
    ).toHaveAttribute("href", "/campaigns/new");
  });

  test("renders an empty state when there are no campaigns", async () => {
    h.listCampaignsWithCounts.mockResolvedValue([]);
    render(await CampaignsPage());
    expect(screen.getByText(/no campaigns/i)).toBeInTheDocument();
  });
});
