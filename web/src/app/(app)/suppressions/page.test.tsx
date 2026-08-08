import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  listSuppressions: vi.fn(),
  countSuppressions: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/sms/repo", () => ({
  listSuppressions: h.listSuppressions,
  countSuppressions: h.countSuppressions,
}));
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// The table + add form are client islands using useRouter.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import SuppressionsPage from "./page";

const manualEntry = {
  phone_e164: "+15550000006",
  reason: "manual",
  raw: { added_by: "amy@nsight.example", note: "asked by phone" },
  created_at: "2026-08-05T12:00:00Z",
};

async function renderPage(searchParams: { q?: string } = {}) {
  return render(
    await SuppressionsPage({ searchParams: Promise.resolve(searchParams) }),
  );
}

describe("suppressions/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listSuppressions.mockReset().mockResolvedValue([manualEntry]);
    h.countSuppressions.mockReset().mockResolvedValue(42);
    h.requireMarketingUser.mockReset().mockResolvedValue({
      email: "amy@nsight.example",
      groups: ["marketing"],
    });
  });

  test("enforces the gate, shows the total, and lists entries", async () => {
    await renderPage();
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.listSuppressions).toHaveBeenCalledWith({}, h.userDb);
    expect(
      screen.getByRole("heading", { name: "Suppressions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("42 suppressed")).toBeInTheDocument();
    expect(screen.getByText("+15550000006")).toBeInTheDocument();
  });

  test("?q= drives the server-side digit search and pre-fills the box", async () => {
    await renderPage({ q: "555 000" });
    expect(h.listSuppressions).toHaveBeenCalledWith(
      { query: "555 000" },
      h.userDb,
    );
    expect(screen.getByRole("searchbox")).toHaveValue("555 000");
  });
});
