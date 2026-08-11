import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
}));

vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

// SearchPanel is a client component using the app-router hooks.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/intel/search",
  useSearchParams: () => new URLSearchParams(),
}));

import IntelSearchPage from "./page";
import { STUB_BADGE_TEXT } from "@/components/intel/status";

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ sources: [], stats: [] }),
      } as Response),
    ),
  );
}

describe("intel/search/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("enforces the marketing group gate", async () => {
    render(await IntelSearchPage());
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("renders the agentic search panel", async () => {
    render(await IntelSearchPage());
    expect(
      screen.getByRole("heading", { name: /intel search/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("searchbox", { name: /search competitor intel/i }),
    ).toBeInTheDocument();
  });

  test("the embedding-provider badge left this surface (search is FTS + gateway now)", async () => {
    render(await IntelSearchPage());
    // The stub-embeddings badge stays on the document/source pages, where
    // the dormant pgvector pipeline is deliberately visible — never here.
    expect(screen.queryByText(STUB_BADGE_TEXT)).not.toBeInTheDocument();
    // The old static "synthesis deferred" panel is gone with it.
    expect(
      screen.queryByText(/answer synthesis pending sign-off/i),
    ).not.toBeInTheDocument();
  });
});
