import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireSectionUser: vi.fn(),
}));

// Gated server-side on the intel section; stub the gate (unit-tested in
// requireSection.test.ts) so these tests focus on the page body.
vi.mock("@/lib/requireSection", () => ({
  requireSectionUser: h.requireSectionUser,
}));

// SearchPanel is a client component using the app-router hooks.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/intel",
  useSearchParams: () => new URLSearchParams(),
}));

import IntelPage from "./page";
import { STUB_BADGE_TEXT } from "@/components/intel/status";

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response),
    ),
  );
}

describe("intel/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireSectionUser.mockReset();
    h.requireSectionUser.mockResolvedValue({
      ok: true,
      user: {
        email: "amy@nsight.example",
        name: "Amy",
        groups: ["mh-section-intel"],
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("enforces the intel section gate", async () => {
    stubFetch(200, { sources: [] });
    render(await IntelPage());
    expect(h.requireSectionUser).toHaveBeenCalledWith("intel");
  });

  test("renders the terse 403 panel when the intel section is missing", async () => {
    h.requireSectionUser.mockResolvedValue({ ok: false });
    render(await IntelPage());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Competitor Intel access required.",
    );
    expect(
      screen.queryByRole("searchbox", { name: /search competitor intel/i }),
    ).not.toBeInTheDocument();
  });

  test("renders search on top and the sources manager below — no separate search page", async () => {
    stubFetch(200, { sources: [] });
    render(await IntelPage());

    expect(
      screen.getByRole("heading", { level: 1, name: /competitor intel/i }),
    ).toBeInTheDocument();
    // The search bar lives on this page now (the old /intel/search 308s here).
    expect(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^search$/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/no sources yet/i)).toBeInTheDocument();
  });

  test("the embedding-provider badge stays off the search surface (FTS + gateway)", async () => {
    stubFetch(200, { sources: [] });
    render(await IntelPage());
    // The stub-embeddings badge belongs on the document/source pages, where
    // the dormant pgvector pipeline is deliberately visible — never here.
    expect(screen.queryByText(STUB_BADGE_TEXT)).not.toBeInTheDocument();
    // The old static "synthesis deferred" panel is gone with it.
    expect(
      screen.queryByText(/answer synthesis pending sign-off/i),
    ).not.toBeInTheDocument();
  });

  test("surfaces the not-provisioned state through the manager", async () => {
    stubFetch(503, { error: "intel-not-provisioned", message: "schema not applied" });
    render(await IntelPage());
    expect(
      await screen.findByText(/isn't provisioned yet/i),
    ).toBeInTheDocument();
  });
});
