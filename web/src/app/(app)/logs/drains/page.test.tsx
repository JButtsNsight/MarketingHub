import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireAdminUser: vi.fn(),
}));

// The page is gated server-side on the admin group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// auth.test.ts). Tests below verify the gate is enforced BEFORE any content
// renders, for both the signed-out and the non-admin outcome.
vi.mock("@/lib/requireAdminUser", () => ({
  requireAdminUser: h.requireAdminUser,
}));

import LogDrainsPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

// The seven console source ids the Logs explorer queries — the pipeline map
// must list every one (and none of the empty self-hosted sources).
const CONSOLE_SOURCES = [
  "edge_logs",
  "postgres_logs",
  "auth_logs",
  "postgrest_logs",
  "realtime_logs",
  "storage_logs",
  "function_edge_logs",
] as const;

describe("logs/drains/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("renders the honest static capability panel behind the gate", async () => {
    render(await LogDrainsPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Log Drains", level: 1 }),
    ).toBeInTheDocument();

    // Honest capability statement: real upstream (Logflare 1.36.1), off here.
    expect(screen.getAllByText(/Logflare 1\.36\.1/).length).toBeGreaterThan(0);
    expect(screen.getByText("Not enabled here")).toBeInTheDocument();
    expect(
      screen.getByText(/no drain exists or can be created/i),
    ).toBeInTheDocument();

    // Coverage story: in-stack vector→Logflare + CloudWatch as infra truth.
    // Runbook pointers live in docs, not the UI.
    expect(
      screen.getByText(/In-stack pipeline \(vector → Logflare\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/CloudWatch — infrastructure log & alarm truth/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/docs\/runbooks\/w6-analytics-headroom\.md/),
    ).not.toBeInTheDocument();
  });

  test("pipeline map lists exactly the seven shipped sources", async () => {
    render(await LogDrainsPage());

    for (const source of CONSOLE_SOURCES) {
      expect(screen.getByRole("cell", { name: source })).toBeInTheDocument();
    }
    // Sources that exist in logs.all but receive nothing self-hosted must NOT
    // be advertised as shipped streams.
    expect(screen.queryByText("function_logs")).not.toBeInTheDocument();
    expect(screen.queryByText("pgbouncer_logs")).not.toBeInTheDocument();
  });

  test("page is static — never fetches, no Logflare/network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      render(await LogDrainsPage());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("signed-in non-admin gets the terse 403 panel, no content", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await LogDrainsPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByText("Log Drains")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(LogDrainsPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
