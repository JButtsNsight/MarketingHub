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

import AdvisorsMovedRedirect from "./page";

async function run(slug?: string[]) {
  await expect(
    AdvisorsMovedRedirect({ params: Promise.resolve({ slug }) }),
  ).rejects.toThrow(/NEXT_REDIRECT/);
}

describe("advisors/page.tsx (moved → /admin/advisors redirect stub)", () => {
  beforeEach(() => {
    h.permanentRedirect.mockClear();
  });

  test("308s a bare /advisors to /admin/advisors", async () => {
    await run();
    expect(h.permanentRedirect).toHaveBeenCalledWith("/admin/advisors");
  });

  test("carries deep-link segments to the new home", async () => {
    await run(["security", "rls"]);
    expect(h.permanentRedirect).toHaveBeenCalledWith(
      "/admin/advisors/security/rls",
    );
  });

  test("an empty slug array still lands on the bare route", async () => {
    await run([]);
    expect(h.permanentRedirect).toHaveBeenCalledWith("/admin/advisors");
  });
});
