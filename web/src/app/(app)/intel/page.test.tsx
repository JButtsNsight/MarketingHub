import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
}));

// Gated server-side on the marketing group; stub the gate (unit-tested in
// requireMarketingUser.test.ts) so these tests focus on the page body.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

import IntelPage from "./page";

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
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("enforces the marketing group gate", async () => {
    stubFetch(200, { sources: [] });
    render(await IntelPage());
    expect(h.requireMarketingUser).toHaveBeenCalled();
  });

  test("renders the title-only header and the sources manager", async () => {
    stubFetch(200, { sources: [] });
    render(await IntelPage());

    expect(
      screen.getByRole("heading", { level: 1, name: /competitor intel/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/no sources yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /semantic search/i })).toHaveAttribute(
      "href",
      "/intel/search",
    );
  });

  test("surfaces the not-provisioned state through the manager", async () => {
    stubFetch(503, { error: "intel-not-provisioned", message: "schema not applied" });
    render(await IntelPage());
    expect(
      await screen.findByText(/isn't provisioned yet/i),
    ).toBeInTheDocument();
  });
});
