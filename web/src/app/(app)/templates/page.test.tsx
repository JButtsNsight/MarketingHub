import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Template } from "@/lib/templates/schema";

const h = vi.hoisted(() => ({
  searchTemplates: vi.fn(),
  requireMarketingUser: vi.fn(),
  redirect: vi.fn((to: string) => {
    // Next's redirect() throws — mirror that so the page function never returns.
    throw new Error(`REDIRECT:${to}`);
  }),
  // Sentinel client threaded by the view into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));
vi.mock("@/lib/templates/repo", () => ({
  searchTemplates: h.searchTemplates,
}));
// The view is gated server-side on the marketing group; stub the gate so these
// render tests focus on the body (the gate itself is unit-tested in
// requireMarketingUser.test.ts).
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
// SearchBar/FilterChips/Tabs use next/navigation client hooks; stub them for
// the server-component render. redirect backs the /templates bookmark shim.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/campaigns/templates",
  useSearchParams: () => new URLSearchParams(""),
  redirect: h.redirect,
}));

import TemplatesRedirect from "./page";
import SmsTemplatesPage from "../campaigns/templates/page";
import EmailTemplatesPage from "../email/templates/page";

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

describe("typed template tabs (server components)", () => {
  beforeEach(() => {
    h.searchTemplates.mockReset();
    h.requireMarketingUser.mockReset();
    h.redirect.mockClear();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  test("SMS view enforces the marketing gate and LOCKS type=text", async () => {
    h.searchTemplates.mockResolvedValue([tpl("a", "Alpha")]);
    const ui = await SmsTemplatesPage({
      searchParams: Promise.resolve({ q: "spring", category: "Promotion" }),
    });
    render(ui);
    expect(h.requireMarketingUser).toHaveBeenCalled();
    expect(h.searchTemplates).toHaveBeenCalledWith(
      "spring",
      { category: "Promotion", type: "text" },
      h.userDb,
    );
    expect(screen.getByRole("link", { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByText(/1 result/i)).toBeInTheDocument();
    // The type is locked by the tab — no type filter chips render.
    expect(screen.queryByRole("group", { name: /filter by type/i })).toBeNull();
    // The SMS tab strip hosts the view.
    expect(screen.getByRole("link", { name: "Suppressions" })).toBeInTheDocument();
  });

  test("Email view locks type=email and hosts the email tab strip", async () => {
    h.searchTemplates.mockResolvedValue([]);
    const ui = await EmailTemplatesPage({ searchParams: Promise.resolve({}) });
    render(ui);
    expect(h.searchTemplates).toHaveBeenCalledWith(
      "",
      { category: undefined, type: "email" },
      h.userDb,
    );
    expect(screen.getByText(/no templates/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Master Inbox" })).toBeInTheDocument();
  });

  test("labels the count as 'total' when browsing with no filters", async () => {
    h.searchTemplates.mockResolvedValue([tpl("a", "Alpha"), tpl("b", "Beta")]);
    const ui = await SmsTemplatesPage({ searchParams: Promise.resolve({}) });
    render(ui);
    expect(screen.getByText(/2 total/i)).toBeInTheDocument();
  });

  test("/templates bookmarks redirect to the SMS view, params intact", async () => {
    await expect(
      TemplatesRedirect({
        searchParams: Promise.resolve({ q: "spring", category: "Promotion" }),
      }),
    ).rejects.toThrow("REDIRECT:/campaigns/templates?q=spring&category=Promotion");
  });

  test("/templates?type=email bookmarks redirect to the email view", async () => {
    await expect(
      TemplatesRedirect({ searchParams: Promise.resolve({ type: "email" }) }),
    ).rejects.toThrow("REDIRECT:/email/templates");
  });
});
