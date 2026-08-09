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
import { RAG_DEFERRED_TEXT, STUB_BADGE_TEXT } from "@/components/intel/status";

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

  test("RAG answer panel is the honest deferred note — no aspirational UI", async () => {
    render(await IntelSearchPage());
    expect(screen.getByText(RAG_DEFERRED_TEXT)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /answer synthesis/i }),
    ).toBeInTheDocument();
  });

  test("default env (provider unset) is labeled as stub embeddings", async () => {
    render(await IntelSearchPage());
    expect(screen.getByText(STUB_BADGE_TEXT)).toBeInTheDocument();
  });

  test("a misconfigured CI_EMBED_PROVIDER degrades honestly, not fatally", async () => {
    vi.stubEnv("CI_EMBED_PROVIDER", "bogus");
    render(await IntelSearchPage());
    expect(
      screen.getByText(/embedding provider misconfigured/i),
    ).toBeInTheDocument();
  });
});
