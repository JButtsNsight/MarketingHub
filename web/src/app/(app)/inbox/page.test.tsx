import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listInboundMessages: vi.fn(),
  countUnhandledInbound: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
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
// InboxTable is a client island using useRouter.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

describe("inbox/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listInboundMessages.mockReset().mockResolvedValue([message]);
    h.countUnhandledInbound.mockReset().mockResolvedValue(1);
    h.requireMarketingUser.mockReset().mockResolvedValue({
      email: "amy@nsight.example",
      groups: ["marketing"],
    });
  });

  test("enforces the marketing gate and lists every reply by default", async () => {
    await renderPage();
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.listInboundMessages).toHaveBeenCalledWith(
      { unhandledOnly: false },
      h.userDb,
    );
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("Yes, what time works?")).toBeInTheDocument();
    expect(screen.getByText(/1 needs a reply/)).toBeInTheDocument();
  });

  test("?filter=unhandled narrows the read", async () => {
    await renderPage({ filter: "unhandled" });
    expect(h.listInboundMessages).toHaveBeenCalledWith(
      { unhandledOnly: true },
      h.userDb,
    );
  });

  test("a clear inbox says so", async () => {
    h.listInboundMessages.mockResolvedValue([]);
    h.countUnhandledInbound.mockResolvedValue(0);
    await renderPage();
    expect(screen.getByText("all handled")).toBeInTheDocument();
    expect(screen.getByText("No replies yet.")).toBeInTheDocument();
  });
});
