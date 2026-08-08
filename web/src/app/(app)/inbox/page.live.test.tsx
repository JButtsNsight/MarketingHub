import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

/**
 * Wave-5 live-view tests for the inbox. The foundation wrapper
 * (`@/lib/realtime/client`) is mocked so tests drive its status and events by
 * hand: `live` proves updates apply via router.refresh(); `unavailable`
 * (= realtime unreachable, nothing applied yet) proves today's static render
 * and behavior are preserved byte-for-byte.
 */
const h = vi.hoisted(() => ({
  listInboundMessages: vi.fn(),
  countUnhandledInbound: vi.fn(),
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
  listInboundMessages: h.listInboundMessages,
  countUnhandledInbound: h.countUnhandledInbound,
}));
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// Both client islands (InboxTable, LiveRefresher) use useRouter; live updates
// must land as calls to this shared refresh spy.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/realtime/client", () => ({
  useLiveTopic: (topic: unknown, options = {}) => {
    h.liveCalls.push({ topic, options });
    return h.liveStatus;
  },
}));

import InboxPage from "./page";

const message = {
  id: "in-1",
  phone_e164: "+15550000004",
  body: "Yes, what time works?",
  received_at: "2026-08-05T14:30:00Z",
  matched_recipient_id: "r7",
  matched_campaign_id: "c-3",
  handled: false,
  handled_by: null,
  handled_at: null,
  raw: {},
  campaign: { id: "c-3", name: "August recall" },
};

async function renderPage(searchParams: { filter?: string } = {}) {
  return render(
    await InboxPage({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("inbox/page.tsx (live view)", () => {
  beforeEach(() => {
    h.listInboundMessages.mockReset().mockResolvedValue([message]);
    h.countUnhandledInbound.mockReset().mockResolvedValue(1);
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

  test("live: subscribes to mh:inbox and a change event applies via a debounced refresh", async () => {
    h.liveStatus = "live";
    vi.useFakeTimers();
    await renderPage();

    expect(h.liveCalls[0].topic).toBe("mh:inbox");
    expect(screen.getByText("Live")).toBeInTheDocument();

    act(() => {
      h.liveCalls.at(-1)!.options.onEvent?.("change", { id: "in-9" }, "mh:inbox");
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

    // Exactly today's static inbox: gate, repo reads, rows, header count.
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.listInboundMessages).toHaveBeenCalledWith(
      { unhandledOnly: false },
      h.userDb,
    );
    expect(h.countUnhandledInbound).toHaveBeenCalledWith(h.userDb);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("Yes, what time works?")).toBeInTheDocument();
    expect(screen.getByText(/1 needs a reply/)).toBeInTheDocument();

    // No live chrome, no surprise refreshes.
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
