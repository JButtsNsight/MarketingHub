import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Template } from "@/lib/templates/schema";

const h = vi.hoisted(() => ({
  searchTemplates: vi.fn(),
  requireMarketingUser: vi.fn(),
  // Sentinel client threaded by the page into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/templates/repo", () => ({
  searchTemplates: h.searchTemplates,
}));
// The page is gated server-side on the marketing group; stub the gate so these
// render tests focus on the page body (the gate itself is unit-tested in
// requireMarketingUser.test.ts).
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// SearchBar/FilterChips use next/navigation client hooks; stub them for the
// server-component render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(""),
}));

import TemplatesPage from "./page";

function tpl(id: string, name: string): Template {
  return {
    id,
    name,
    type: "text",
    category: "Newsletter",
    tags: [],
    subject: null,
    body: "hi",
    storage_path: null,
    created_by: "amy@nsight.example",
    created_at: "2026-07-05T12:00:00Z",
    updated_at: "2026-07-05T12:00:00Z",
  };
}

describe("templates/page.tsx (server component)", () => {
  beforeEach(() => {
    h.searchTemplates.mockReset();
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("enforces the marketing group gate before reading templates", async () => {
    h.searchTemplates.mockResolvedValue([]);
    await TemplatesPage({ searchParams: Promise.resolve({}) });
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("reads q/category/type from searchParams and calls the repo", async () => {
    h.searchTemplates.mockResolvedValue([tpl("a", "Alpha")]);
    const ui = await TemplatesPage({
      searchParams: Promise.resolve({
        q: "spring",
        category: "Promotion",
        type: "email",
      }),
    });
    render(ui);

    expect(h.searchTemplates).toHaveBeenCalledWith(
      "spring",
      { category: "Promotion", type: "email" },
      h.userDb,
    );
    expect(screen.getByRole("link", { name: /alpha/i })).toBeInTheDocument();
    // filtered/searched view labels the count as matches, not the library total.
    expect(screen.getByText(/1 result/i)).toBeInTheDocument();
  });

  test("labels the count as 'total' when browsing with no filters", async () => {
    h.searchTemplates.mockResolvedValue([tpl("a", "Alpha"), tpl("b", "Beta")]);
    const ui = await TemplatesPage({ searchParams: Promise.resolve({}) });
    render(ui);
    expect(screen.getByText(/2 total/i)).toBeInTheDocument();
  });

  test("renders an empty state when there are no results", async () => {
    h.searchTemplates.mockResolvedValue([]);
    const ui = await TemplatesPage({ searchParams: Promise.resolve({}) });
    render(ui);
    expect(screen.getByText(/no templates/i)).toBeInTheDocument();
  });

  test("ignores an invalid type value from the URL", async () => {
    h.searchTemplates.mockResolvedValue([]);
    const ui = await TemplatesPage({
      searchParams: Promise.resolve({ type: "bogus" }),
    });
    render(ui);
    expect(h.searchTemplates).toHaveBeenCalledWith(
      "",
      { category: undefined, type: undefined },
      h.userDb,
    );
  });
});
