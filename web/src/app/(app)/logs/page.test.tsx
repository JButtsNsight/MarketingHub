import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => {
  /**
   * Stand-in for the foundation lib's class — the page's `instanceof` check
   * runs against the mocked module, so this class IS the one it sees.
   */
  class AnalyticsUnavailableError extends Error {
    constructor(detail: string) {
      super(`[console:logs] analytics unreachable: ${detail}`);
      this.name = "AnalyticsUnavailableError";
    }
  }
  return {
    requireAdminUser: vi.fn(),
    listSources: vi.fn(),
    queryLogs: vi.fn(),
    AnalyticsUnavailableError,
  };
});

// The page is gated server-side on the admin group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// auth.test.ts). The initial queryLogs runs IN the page (never through the
// gated /api/console/logs route), so the tests below verify the gate is
// enforced BEFORE any Logflare read, for both the signed-out and the
// non-admin outcome.
vi.mock("@/lib/requireAdminUser", () => ({
  requireAdminUser: h.requireAdminUser,
}));

vi.mock("@/lib/console/logs", () => ({
  AnalyticsUnavailableError: h.AnalyticsUnavailableError,
  listSources: h.listSources,
  queryLogs: h.queryLogs,
}));

// The client island's behavior has its own tests; stub it to a props probe.
vi.mock("@/components/console/LogsClient", () => ({
  LogsClient: (props: {
    initialEntries: unknown[];
    initialError: string | null;
  }) => (
    <div
      data-testid="logs-client"
      data-entries={props.initialEntries.length}
      data-error={props.initialError ?? ""}
    />
  ),
}));

import LogsPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

const SOURCES = [
  {
    id: "edge_logs",
    label: "API / Kong",
    severity: { values: ["error", "warning"] },
  },
];

const ENTRY = {
  id: "log-1",
  timestamp: "2026-08-11T12:00:00Z",
  event_message: "GET /rest/v1/templates 200",
};

describe("logs/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
    h.listSources.mockReset().mockReturnValue(SOURCES);
    h.queryLogs.mockReset().mockResolvedValue([ENTRY]);
  });

  test("queries the last hour of edge_logs and mounts the explorer behind the gate", async () => {
    render(await LogsPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Logs", level: 1 }),
    ).toBeInTheDocument();
    expect(h.queryLogs).toHaveBeenCalledTimes(1);
    expect(h.queryLogs.mock.calls[0][0].source).toBe("edge_logs");
    const client = screen.getByTestId("logs-client");
    expect(client.dataset.entries).toBe("1");
    expect(client.dataset.error).toBe("");
  });

  test("AnalyticsUnavailableError → honest unavailable state, no explorer", async () => {
    h.queryLogs.mockRejectedValue(
      new h.AnalyticsUnavailableError("LOGFLARE_PRIVATE_ACCESS_TOKEN unset"),
    );
    render(await LogsPage());

    expect(
      screen.getByRole("heading", { name: "Analytics unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("logs-client")).not.toBeInTheDocument();
  });

  test("non-unavailable query failure → explorer renders with the stripped error", async () => {
    h.queryLogs.mockRejectedValue(
      new Error("[console:logs] query failed: 400 bad range"),
    );
    render(await LogsPage());

    const client = screen.getByTestId("logs-client");
    expect(client.dataset.entries).toBe("0");
    expect(client.dataset.error).toBe("400 bad range");
  });

  test("signed-in non-admin gets the terse 403 panel — no log data is read", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await LogsPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByTestId("logs-client")).not.toBeInTheDocument();
    expect(h.queryLogs).not.toHaveBeenCalled();
    expect(h.listSources).not.toHaveBeenCalled();
  });

  test("signed-out gate failure (redirect) propagates before any log read", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(LogsPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.queryLogs).not.toHaveBeenCalled();
    expect(h.listSources).not.toHaveBeenCalled();
  });
});
