import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Template } from "@/lib/templates/schema";

const h = vi.hoisted(() => ({
  getTemplate: vi.fn(),
  requireMarketingUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/templates/repo", () => ({ getTemplate: h.getTemplate }));
vi.mock("next/navigation", () => ({
  notFound: h.notFound,
  useRouter: () => ({ refresh: vi.fn() }),
}));
// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the detail render.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

import TemplateDetailPage from "./page";

const template: Template = {
  id: "t2",
  name: "Welcome",
  type: "email",
  category: "Onboarding",
  tags: ["welcome", "intro"],
  subject: "Welcome aboard",
  body: "<h1>Hi</h1>",
  storage_path: null,
  created_by: "amy@nsight.example",
  created_at: "2026-07-05T12:00:00Z",
  updated_at: "2026-07-05T12:00:00Z",
};

describe("templates/[id]/page.tsx (server component)", () => {
  beforeEach(() => {
    h.getTemplate.mockReset();
    h.notFound.mockClear();
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("renders the preview and a metadata sidebar for a found template", async () => {
    h.getTemplate.mockResolvedValue(template);
    const ui = await TemplateDetailPage({ params: Promise.resolve({ id: "t2" }) });
    render(ui);

    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.getTemplate).toHaveBeenCalledWith("t2");
    // name heading
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    // metadata sidebar values
    expect(screen.getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("amy@nsight.example")).toBeInTheDocument();
    expect(screen.getByText("welcome")).toBeInTheDocument();
    expect(screen.getByText("intro")).toBeInTheDocument();
  });

  test("calls notFound() when the template does not exist", async () => {
    h.getTemplate.mockResolvedValue(null);
    await expect(
      TemplateDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(h.notFound).toHaveBeenCalled();
  });
});
