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
  requireMarketingUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/sms/repo", () => ({
  getCampaign: h.getCampaign,
  getCampaignCounts: h.getCampaignCounts,
  getCampaignRecipients: h.getCampaignRecipients,
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
  monday_board_id: "4567890123",
  monday_phone_column_id: "phone_col",
  message_body: "Hi {{firstName}}, time for a visit.",
  send_date: "2026-08-03",
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
  claimed_at: null,
  claim_expires_at: null,
  st_message_id: null,
  st_credits: null,
  last_error: "timeout",
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
  });

  test("enforces the marketing group gate and reads by the route param", async () => {
    await renderPage("c1");
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.getCampaign).toHaveBeenCalledWith("c1");
    expect(h.getCampaignCounts).toHaveBeenCalledWith("c1");
    expect(h.getCampaignRecipients).toHaveBeenCalledWith("c1");
  });

  test("renders name, status badge, the 11:30 AM ET send instant, and metadata", async () => {
    await renderPage();
    expect(
      screen.getByRole("heading", { name: /august recall/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("sending")).toBeInTheDocument();
    expect(screen.getByText(/11:30 AM ET, 2026-08-03/)).toBeInTheDocument();
    // template / board provenance
    expect(
      screen.getByText("11111111-1111-4111-8111-111111111111"),
    ).toBeInTheDocument();
    expect(screen.getByText("4567890123")).toBeInTheDocument();
    expect(screen.getByText("phone_col")).toBeInTheDocument();
  });

  test("renders the per-status StatCard row", async () => {
    h.getCampaignCounts.mockResolvedValue(
      counts({
        pending: 17,
        sent: 15,
        delivered: 14,
        failed: 13,
        failed_ambiguous: 12,
        suppressed: 11,
      }),
    );
    await renderPage();

    const expectStat = (label: RegExp, value: string) => {
      const card = screen.getByText(label).closest(".stat-card")!;
      expect(within(card as HTMLElement).getByText(value)).toBeInTheDocument();
    };
    expectStat(/pending/i, "17");
    expectStat(/^sent$/i, "15");
    expectStat(/delivered/i, "14");
    expectStat(/^failed$/i, "13");
    expectStat(/^ambiguous$/i, "12");
    expectStat(/suppressed/i, "11");
  });

  test("renders the campaign actions and the recipients table", async () => {
    await renderPage();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    // failed_ambiguous row exposes its manual-review lane
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  test("calls notFound() when the campaign does not exist", async () => {
    h.getCampaign.mockResolvedValue(null);
    await expect(
      CampaignDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(h.notFound).toHaveBeenCalled();
  });
});
