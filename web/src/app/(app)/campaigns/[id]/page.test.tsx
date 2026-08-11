import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { CountsByStatus } from "@/lib/sms/repo";
import {
  RECIPIENT_STATUSES,
  type SmsCampaign,
  type SmsCampaignRecipient,
} from "@/lib/sms/schema";

const h = vi.hoisted(() => ({
  getCampaign: vi.fn(),
  getCampaignCounts: vi.fn(),
  getCampaignRecipients: vi.fn(),
  getCampaignEngagement: vi.fn(),
  listInboundMessages: vi.fn(),
  getExplicitZoneCounts: vi.fn(),
  requireMarketingUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));

vi.mock("@/lib/sms/repo", () => ({
  getCampaign: h.getCampaign,
  getCampaignCounts: h.getCampaignCounts,
  getCampaignRecipients: h.getCampaignRecipients,
  getCampaignEngagement: h.getCampaignEngagement,
  listInboundMessages: h.listInboundMessages,
}));
// Only the view accessor is faked — foldZoneCounts/zoneChip stay real (pure).
vi.mock("@/lib/sms/zoneStats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms/zoneStats")>();
  return { ...actual, getExplicitZoneCounts: h.getExplicitZoneCounts };
});
// Legacy fixture campaigns carry contact_list_id: null, so the page never
// fetches the list — the mock exists to keep the server-only import inert.
vi.mock("@/lib/contacts/repo", () => ({
  getContactList: vi.fn().mockResolvedValue(null),
}));
// CampaignActions/RecipientsTable are client components using useRouter.
vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));
// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the detail render.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

import CampaignDetailPage from "./page";

const campaign: SmsCampaign = {
  id: "c1",
  name: "August recall",
  template_id: "11111111-1111-4111-8111-111111111111",
  contact_list_id: null,
  monday_board_id: "4567890123",
  monday_phone_column_id: "phone_col",
  message_body: "Hi {{firstName}}, time for a visit.",
  send_date: "2026-08-03",
  send_time: "11:30",
  send_timezone: "America/New_York",
  send_at: "2026-08-03T15:30:00Z",
  status: "sending",
  created_by: "amy@nsight.example",
  created_at: "2026-07-22T12:00:00Z",
  updated_at: "2026-07-22T12:00:00Z",
};

function counts(partial: Partial<CountsByStatus> = {}): CountsByStatus {
  const zero = Object.fromEntries(
    RECIPIENT_STATUSES.map((s) => [s, 0]),
  ) as CountsByStatus;
  return { ...zero, ...partial };
}

const recipient: SmsCampaignRecipient = {
  id: "r1",
  campaign_id: "c1",
  monday_item_id: "900100",
  name: "Jane Doe",
  first_name: "Jane",
  phone_e164: "+15559234567",
  rendered_text: "Hi Jane, time for a visit.",
  status: "failed_ambiguous",
  attempts: 1,
  send_after: "2026-08-03T15:30:00Z",
  send_timezone: null,
  claimed_at: null,
  claim_expires_at: null,
  st_message_id: null,
  st_credits: null,
  last_error: "timeout",
  monday_synced_at: null,
  monday_synced_status: null,
  created_at: "2026-07-22T12:00:00Z",
  updated_at: "2026-07-22T12:00:00Z",
};

async function renderPage(id = "c1") {
  return render(await CampaignDetailPage({ params: Promise.resolve({ id }) }));
}

describe("campaigns/[id]/page.tsx (server component)", () => {
  beforeEach(() => {
    h.getCampaign.mockReset();
    h.getCampaignCounts.mockReset();
    h.getCampaignRecipients.mockReset();
    h.notFound.mockClear();
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
    h.getCampaign.mockResolvedValue(campaign);
    h.getCampaignCounts.mockResolvedValue(counts());
    h.getCampaignRecipients.mockResolvedValue([recipient]);
    h.getCampaignEngagement.mockReset();
    h.getCampaignEngagement.mockResolvedValue({
      campaign_id: "c1",
      tracked_links: 0,
      recipients_clicked: 0,
      total_clicks: 0,
      replies: 0,
      unhandled_replies: 0,
      opt_outs: 0,
    });
    h.listInboundMessages.mockReset();
    h.listInboundMessages.mockResolvedValue([]);
    h.getExplicitZoneCounts.mockReset().mockResolvedValue(new Map());
  });

  test("enforces the marketing group gate and reads by the route param", async () => {
    await renderPage("c1");
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.getCampaign).toHaveBeenCalledWith("c1", h.userDb);
    expect(h.getCampaignCounts).toHaveBeenCalledWith("c1", h.userDb);
    expect(h.getCampaignRecipients).toHaveBeenCalledWith("c1", h.userDb);
  });

  test("renders name, status badge, the send slot, and metadata", async () => {
    await renderPage();
    expect(
      screen.getByRole("heading", { name: /august recall/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("sending")).toBeInTheDocument();
    expect(screen.getByText(/2026-08-03, 11:30 AM ET/)).toBeInTheDocument();
    // template / board provenance
    expect(
      screen.getByText("11111111-1111-4111-8111-111111111111"),
    ).toBeInTheDocument();
    expect(screen.getByText("4567890123")).toBeInTheDocument();
    expect(screen.getByText("phone_col")).toBeInTheDocument();
  });

  test("an audience spanning zones surfaces one N-zones chip (title = spread), from the SAME view the list pages use", async () => {
    // 3 rows total (per the counts view), 2 explicitly PT, remainder → ET.
    // View-backed — NOT the 2000-row-capped recipients fetch, which would
    // disagree with the /campaigns and /schedule chips on large campaigns.
    h.getCampaignCounts.mockResolvedValue(counts({ pending: 1, sent: 2 }));
    h.getExplicitZoneCounts.mockResolvedValue(
      new Map([["c1", new Map([["America/Los_Angeles", 2]])]]),
    );
    await renderPage();
    expect(h.getExplicitZoneCounts).toHaveBeenCalledWith(["c1"], h.userDb);
    const chip = screen.getByText("2 zones");
    expect(chip).toHaveAttribute("title", "ET 1 · PT 2");
  });

  test("a single-zone audience gets no zones chip", async () => {
    await renderPage();
    expect(screen.queryByText(/\d+ zones/)).not.toBeInTheDocument();
  });

  test("renders the per-status StatCard row", async () => {
    h.getCampaignCounts.mockResolvedValue(
      counts({
        pending: 17,
        sent: 15,
        delivered: 14,
        undelivered: 16,
        failed: 13,
        failed_ambiguous: 12,
        suppressed: 11,
        skipped: 10,
      }),
    );
    await renderPage();

    const expectStat = (label: RegExp, value: string) => {
      const card = screen.getByText(label).closest(".stat-card")!;
      expect(within(card as HTMLElement).getByText(value)).toBeInTheDocument();
    };
    expectStat(/pending/i, "17");
    expectStat(/^sent$/i, "15");
    expectStat(/^delivered$/i, "14");
    // Skipped + Undelivered included so the cards add up to the audience —
    // the shortfall from invalid/duplicate phones must not be hidden.
    expectStat(/^undelivered$/i, "16");
    expectStat(/^failed$/i, "13");
    expectStat(/^ambiguous$/i, "12");
    expectStat(/suppressed/i, "11");
    expectStat(/skipped/i, "10");
  });

  test("renders the campaign actions and the recipients table", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    // failed_ambiguous row exposes its manual-review lane
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  test("a canceled campaign hides Retry but keeps Mark failed", async () => {
    h.getCampaign.mockResolvedValue({ ...campaign, status: "canceled" });
    await renderPage();
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark failed/i }),
    ).toBeInTheDocument();
  });

  test("calls notFound() when the campaign does not exist", async () => {
    h.getCampaign.mockResolvedValue(null);
    await expect(
      CampaignDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(h.notFound).toHaveBeenCalled();
  });
});
