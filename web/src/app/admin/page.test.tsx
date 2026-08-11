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

import AdminMovedRedirect from "./page";

describe("admin/page.tsx (landing retired → /overview redirect stub)", () => {
  beforeEach(() => {
    h.permanentRedirect.mockClear();
  });

  test("308s /admin to /overview", () => {
    expect(() => AdminMovedRedirect()).toThrow(/NEXT_REDIRECT/);
    expect(h.permanentRedirect).toHaveBeenCalledWith("/overview");
  });
});
