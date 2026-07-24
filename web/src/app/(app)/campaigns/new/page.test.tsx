import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Template } from "@/lib/templates/schema";

const h = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  isMondayConfigured: vi.fn(),
  requireMarketingUser: vi.fn(),
}));

vi.mock("@/lib/templates/repo", () => ({ listTemplates: h.listTemplates }));
vi.mock("@/lib/monday/client", () => ({
  isMondayConfigured: h.isMondayConfigured,
}));
// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the page body.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// NewCampaignForm uses next/navigation client hooks; stub for the render.
vi.mock("next/navigation", () => ({
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

describe("campaigns/new/page.tsx (server component)", () => {
  beforeEach(() => {
    h.listTemplates.mockReset();
    h.isMondayConfigured.mockReset();
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("enforces the marketing group gate", async () => {
    h.isMondayConfigured.mockReturnValue(true);
    h.listTemplates.mockResolvedValue([]);
    render(await NewCampaignPage());
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("renders the creation form with text templates when Monday is configured", async () => {
    h.isMondayConfigured.mockReturnValue(true);
    h.listTemplates.mockResolvedValue([template]);
    render(await NewCampaignPage());

    expect(h.listTemplates).toHaveBeenCalledWith({ type: "text" });
    expect(screen.getByLabelText(/campaign name/i)).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /checkup reminder/i }),
    ).toBeInTheDocument();
  });

  test("renders the unconfigured callout (no form) when Monday is not configured", async () => {
    h.isMondayConfigured.mockReturnValue(false);
    render(await NewCampaignPage());

    expect(h.listTemplates).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/campaign name/i)).toBeNull();
    // The callout names the missing env var and points at the deploy runbook.
    expect(screen.getByText(/MONDAY_API_TOKEN/)).toBeInTheDocument();
    expect(
      screen.getByText(/marketinghub-app-deploy\.md/),
    ).toBeInTheDocument();
  });
});
