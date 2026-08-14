import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CountsByStatus } from "@/lib/sms/repo";
import { RECIPIENT_STATUSES, type SmsCampaign } from "@/lib/sms/schema";

/**
 * Wave-5 live-view tests for the campaign detail page. The foundation wrapper
 * (`@/lib/realtime/client`) is mocked so tests drive its status and events by
 * hand: `live` proves updates apply via router.refresh(); `unavailable`
 * (= realtime unreachable, nothing applied yet) proves today's static render
 * and behavior are preserved.
 */
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
  liveStatus: "unavailable" as string,
  liveCalls: [] as Array<{
    topic: unknown;
    options: {
      onEvent?: (
        event: string,
        payload: Record<string, unknown>,
        topic: string,
      ) => void;
    };
  }>,
  refresh: vi.fn(),
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
// Only the DB aggregate is stubbed — the fold/chip helpers stay real.
vi.mock("@/lib/sms/zoneStats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/zoneStats")>()),
  getExplicitZoneCounts: h.getExplicitZoneCounts,
}));
// Fixture campaign carries contact_list_id: null, so the page never fetches
// the list — the mock keeps the server-only import inert.
vi.mock("@/lib/contacts/repo", () => ({
  getContactList: vi.fn().mockResolvedValue(null),
}));
// The page's client islands (CampaignActions, RecipientsTable, LiveRefresher)
// use useRouter; live updates must land as calls to this shared refresh spy.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  notFound: h.notFound,
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
vi.mock("@/lib/realtime/client", () => ({
  useLiveTopic: (topic: unknown, options = {}) => {
    h.liveCalls.push({ topic, options });
    return h.liveStatus;
  },
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

async function renderPage(id = "c1") {
  return render(await CampaignDetailPage({ params: Promise.resolve({ id }) }));
}

describe("campaigns/[id]/page.tsx (live view)", () => {
  beforeEach(() => {
    h.getCampaign.mockReset().mockResolvedValue(campaign);
    h.getCampaignCounts.mockReset().mockResolvedValue(counts({ pending: 17 }));
    h.getCampaignRecipients.mockReset().mockResolvedValue([]);
    h.getCampaignEngagement.mockReset().mockResolvedValue({
      campaign_id: "c1",
      tracked_links: 0,
      recipients_clicked: 0,
      total_clicks: 0,
      replies: 0,
      unhandled_replies: 0,
      opt_outs: 0,
    });
    h.listInboundMessages.mockReset().mockResolvedValue([]);
    h.getExplicitZoneCounts.mockReset().mockResolvedValue(new Map());
    h.requireMarketingUser.mockReset().mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
    h.refresh.mockReset();
    h.liveCalls.length = 0;
    h.liveStatus = "unavailable";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("live: subscribes to the campaign topic AND the inbox, applies changes via a debounced refresh", async () => {
    h.liveStatus = "live";
    vi.useFakeTimers();
    await renderPage("c1");

    // Both topics: the campaign's own trigger fan-out plus new replies.
    expect(h.liveCalls[0].topic).toEqual(["mh:campaign:c1", "mh:inbox"]);
    expect(screen.getByText("Live")).toBeInTheDocument();

    act(() => {
      h.liveCalls
        .at(-1)!
        .options.onEvent?.("change", { id: "r9" }, "mh:campaign:c1");
    });
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(h.refresh).not.toHaveBeenCalled(); // inside the 2s debounce
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(h.refresh).toHaveBeenCalledTimes(1); // live update applied
  });

  test("fallback: realtime unavailable preserves today's render and behavior", async () => {
    h.liveStatus = "unavailable";
    await renderPage("c1");

    // Exactly today's static detail: gate, per-id reads, header, stat cards.
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.getCampaign).toHaveBeenCalledWith("c1", h.userDb);
    expect(h.getCampaignCounts).toHaveBeenCalledWith("c1", h.userDb);
    expect(
      screen.getByRole("heading", { name: /august recall/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("sending")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument(); // Pending stat card
    // Existing mutation controls (the current refresh path) still render.
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    // No live chrome, no surprise refreshes.
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
