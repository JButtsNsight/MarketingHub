import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CampaignWithCounts, CountsByStatus } from "@/lib/sms/repo";
import { RECIPIENT_STATUSES } from "@/lib/sms/schema";

/**
 * Wave-5 live-view tests for the blast schedule. The foundation wrapper
 * (`@/lib/realtime/client`) is mocked so tests drive its status and events by
 * hand: `live` proves updates apply via router.refresh(); `unavailable`
 * (= realtime unreachable, nothing applied yet) proves today's static render
 * and behavior are preserved.
 */
const h = vi.hoisted(() => ({
  listCampaignsWithCounts: vi.fn(),
  requireMarketingUser: vi.fn(),
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
  listCampaignsWithCounts: h.listCampaignsWithCounts,
}));
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// LiveRefresher is the page's only client island; live updates must land as
// calls to this shared refresh spy.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/realtime/client", () => ({
  useLiveTopic: (topic: unknown, options = {}) => {
    h.liveCalls.push({ topic, options });
    return h.liveStatus;
  },
}));

import SchedulePage from "./page";

function counts(partial: Partial<CountsByStatus> = {}): CountsByStatus {
  const zero = Object.fromEntries(
    RECIPIENT_STATUSES.map((s) => [s, 0]),
  ) as CountsByStatus;
  return { ...zero, ...partial };
}

const scheduled: CampaignWithCounts = {
  id: "c-sched-1",
  name: "September checkup blast",
  template_id: "11111111-1111-4111-8111-111111111111",
  contact_list_id: null,
  monday_board_id: null,
  monday_phone_column_id: null,
  message_body: "Hi {{firstName}}, time for a visit.",
  send_date: "2026-08-10",
  send_time: "09:00",
  send_timezone: "America/New_York",
  send_at: "2026-08-10T13:00:00Z",
  status: "scheduled",
  created_by: "amy@nsight.example",
  created_at: "2026-08-01T12:00:00Z",
  updated_at: "2026-08-01T12:00:00Z",
  counts: counts({ pending: 12 }),
};

async function renderPage() {
  return render(await SchedulePage());
}

describe("campaigns/schedule/page.tsx (live view)", () => {
  beforeEach(() => {
    h.listCampaignsWithCounts.mockReset().mockResolvedValue([scheduled]);
    h.requireMarketingUser.mockReset().mockResolvedValue({
      email: "amy@nsight.example",
      groups: ["marketing"],
    });
    h.refresh.mockReset();
    h.liveCalls.length = 0;
    h.liveStatus = "unavailable";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("live: subscribes to mh:schedule and a change event applies via a debounced refresh", async () => {
    h.liveStatus = "live";
    vi.useFakeTimers();
    await renderPage();

    expect(h.liveCalls[0].topic).toBe("mh:schedule");
    expect(screen.getByText("Live")).toBeInTheDocument();

    act(() => {
      h.liveCalls
        .at(-1)!
        .options.onEvent?.("change", { id: "c-sched-1" }, "mh:schedule");
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
    await renderPage();

    // Exactly today's static schedule: gate, repo read, grouped-day render.
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.listCampaignsWithCounts).toHaveBeenCalledWith(h.userDb);
    expect(
      screen.getByRole("heading", { name: "Blast schedule" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 on the calendar")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "September checkup blast" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/12 of 12 to send/)).toBeInTheDocument();

    // No live chrome, no surprise refreshes.
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
