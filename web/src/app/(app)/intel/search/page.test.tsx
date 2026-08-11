import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  permanentRedirect: vi.fn((url: string): never => {
    // Mirrors Next: permanentRedirect throws (control never returns).
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  permanentRedirect: h.permanentRedirect,
}));

import IntelSearchMovedRedirect from "./page";

async function run(searchParams: Record<string, string | string[] | undefined>) {
  await expect(
    IntelSearchMovedRedirect({ searchParams: Promise.resolve(searchParams) }),
  ).rejects.toThrow(/NEXT_REDIRECT/);
}

describe("intel/search/page.tsx (moved → /intel redirect stub)", () => {
  beforeEach(() => {
    h.permanentRedirect.mockClear();
  });

  test("308s a bare /intel/search to /intel", async () => {
    await run({});
    expect(h.permanentRedirect).toHaveBeenCalledWith("/intel");
  });

  test("carries the whole query string — shared ?q= searches keep working", async () => {
    await run({ q: "pricing tiers", sourceId: "src-1", count: "5" });
    expect(h.permanentRedirect).toHaveBeenCalledWith(
      "/intel?q=pricing+tiers&sourceId=src-1&count=5",
    );
  });

  test("repeated params survive (array values append, never collapse)", async () => {
    await run({ q: ["a", "b"] });
    expect(h.permanentRedirect).toHaveBeenCalledWith("/intel?q=a&q=b");
  });
});
