import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listAttentionRecipients: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/sms/repo", () => ({
  listAttentionRecipients: h.listAttentionRecipients,
}));
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// AttentionTable is a client island using useRouter.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

import ReviewPage from "./page";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    campaign_id: "c1",
    monday_item_id: null,
    name: "Jane Doe",
    first_name: "Jane",
    phone_e164: "+15559234567",
    rendered_text: "Hi Jane",
    status: "failed_ambiguous",
    attempts: 1,
    send_after: "2026-08-03T15:30:00Z",
    claimed_at: null,
    claim_expires_at: null,
    st_message_id: null,
    st_credits: null,
    last_error: "timeout",
    created_at: "2026-08-03T15:00:00Z",
    updated_at: "2026-08-03T15:31:00Z",
    campaign: { id: "c1", name: "August recall", status: "sending" },
    ...over,
  };
}

describe("review/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listAttentionRecipients.mockReset();
    h.requireMarketingUser.mockReset().mockResolvedValue({
      email: "amy@nsight.example",
      groups: ["marketing"],
    });
  });

  test("enforces the gate and splits the counts by attention status", async () => {
    h.listAttentionRecipients.mockResolvedValue([
      row(),
      row({ id: "r2", status: "failed", phone_e164: "+15550000002" }),
      row({ id: "r3", status: "undelivered", phone_e164: "+15550000003" }),
      row({ id: "r4", status: "undelivered", phone_e164: "+15550000004" }),
    ]);

    render(await ReviewPage());

    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Review queue" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 awaiting a decision")).toBeInTheDocument();
    // stat cards: Ambiguous 1, Failed 1, Undelivered 2
    expect(screen.getByText("Ambiguous")).toBeInTheDocument();
    expect(screen.getByText("Undelivered")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  test("an empty queue reads calm", async () => {
    h.listAttentionRecipients.mockResolvedValue([]);
    render(await ReviewPage());
    expect(screen.getByText("no decisions pending")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs attention.")).toBeInTheDocument();
  });
});
