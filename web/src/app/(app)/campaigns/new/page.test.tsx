import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Template } from "@/lib/templates/schema";
import type { ContactList } from "@/lib/contacts/schema";

const h = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  listContactLists: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/templates/repo", () => ({ listTemplates: h.listTemplates }));
vi.mock("@/lib/contacts/repo", () => ({
  listContactLists: h.listContactLists,
}));
// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the page body.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// NewCampaignForm uses next/navigation client hooks; stub for the render.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

import NewCampaignPage from "./page";

const template: Template = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checkup reminder",
  type: "text",
  category: "Reminder",
  tags: [],
  subject: null,
  body: "Hi {{firstName}}",
  storage_path: null,
  created_by: "amy@nsight.example",
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:00:00Z",
};

const list: ContactList = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "August recall patients",
  source: "csv",
  storage_path: "33333333-3333-4333-8333-333333333333/patients.csv",
  original_filename: "patients.csv",
  monday_board_id: null,
  monday_board_name: null,
  monday_phone_column_id: null,
  monday_timezone_column_id: null,
  monday_outcome_column_id: null,
  contact_count: 42,
  invalid_count: 0,
  duplicate_count: 0,
  created_by: "amy@nsight.example",
  created_at: "2026-07-28T12:00:00Z",
  updated_at: "2026-07-28T12:00:00Z",
};

describe("campaigns/new/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listTemplates.mockReset();
    h.listContactLists.mockReset();
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("enforces the marketing group gate", async () => {
    h.listTemplates.mockResolvedValue([]);
    h.listContactLists.mockResolvedValue([list]);
    render(await NewCampaignPage());
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("renders the creation form with text templates and contact lists", async () => {
    h.listTemplates.mockResolvedValue([template]);
    h.listContactLists.mockResolvedValue([list]);
    render(await NewCampaignPage());

    expect(h.listTemplates).toHaveBeenCalledWith({ type: "text" }, h.userDb);
    expect(screen.getByLabelText(/campaign name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /checkup reminder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /august recall patients/i }),
    ).toBeInTheDocument();
  });

  test("renders the no-lists callout (no form) when no contact list exists yet", async () => {
    h.listTemplates.mockResolvedValue([template]);
    h.listContactLists.mockResolvedValue([]);
    render(await NewCampaignPage());

    expect(screen.queryByLabelText(/campaign name/i)).toBeNull();
    // The callout explains the need and links to list creation.
    expect(screen.getByText(/needs an audience/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /create a contact list/i }),
    ).toHaveAttribute("href", "/campaigns/lists/new");
  });
});
