import { afterEach, describe, expect, test, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { LogEntry } from "@/lib/console/logs";
import { LogsClient, type LogSourceOption } from "./LogsClient";

/**
 * The client talks to the world ONLY through fetch("/api/console/logs?…"),
 * so a stubbed global fetch drives every state: fresh entries, validation
 * errors, and the honest 503 "Analytics unavailable" answer.
 */

const SOURCES: LogSourceOption[] = [
  {
    id: "edge_logs",
    label: "API / Edge (Kong)",
    severities: ["info", "warn", "error"],
  },
  { id: "postgrest_logs", label: "PostgREST" },
];

const ENTRY: LogEntry = {
  ts: "2026-08-08T12:00:00.000Z",
  level: "info",
  service: "api",
  event: "GET /rest/v1/templates 200",
  metadata: { response: [{ status_code: 200 }] },
};

const ERROR_ENTRY: LogEntry = {
  ts: "2026-08-08T12:01:00.000Z",
  level: "error",
  service: "api",
  event: "POST /auth/v1/token 500",
  metadata: { response: [{ status_code: 500 }] },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(body, status)),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** URL of the nth fetch call, parsed for easy searchParams assertions. */
function sentUrl(fn: ReturnType<typeof stubFetch>, call = 0): URL {
  return new URL(String(fn.mock.calls[call]?.[0]), "http://localhost");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LogsClient — render states", () => {
  test("renders the initial server-loaded entries", () => {
    const fn = stubFetch({ entries: [] });
    render(
      <LogsClient sources={SOURCES} initialEntries={[ENTRY, ERROR_ENTRY]} />,
    );

    // Scope to the table — the severity pills also read "info"/"error".
    const table = within(screen.getByRole("table"));
    expect(table.getByText("GET /rest/v1/templates 200")).toBeInTheDocument();
    expect(table.getByText("POST /auth/v1/token 500")).toBeInTheDocument();
    expect(table.getByText("2026-08-08T12:00:00.000Z")).toBeInTheDocument();
    expect(table.getByText("info")).toBeInTheDocument();
    expect(table.getByText("error")).toBeInTheDocument();
    // Nothing fetches until the user asks.
    expect(fn).not.toHaveBeenCalled();
  });

  test("renders the honest empty state when the range has no entries", () => {
    stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[]} />);
    expect(
      screen.getByText("No log entries in this range."),
    ).toBeInTheDocument();
  });

  test("renders an initial server-side error as an alert", () => {
    stubFetch({ entries: [] });
    render(
      <LogsClient
        sources={SOURCES}
        initialEntries={[]}
        initialError="logflare said no"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("logflare said no");
  });

  test("expanding a row reveals its metadata JSON and collapses back", async () => {
    const user = userEvent.setup();
    stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[ENTRY]} />);

    expect(screen.queryByText(/"status_code": 200/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand metadata" }));
    expect(screen.getByText(/"status_code": 200/)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Collapse metadata" }),
    );
    expect(screen.queryByText(/"status_code": 200/)).not.toBeInTheDocument();
  });

  test("severity pills follow the selected source (hidden when it has none)", async () => {
    const user = userEvent.setup();
    const fn = stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[ENTRY]} />);

    // edge_logs → its allowlist renders as pills.
    expect(screen.getByRole("button", { name: "warn" })).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Log source" }),
      "postgrest_logs",
    );

    // Source switch refetches with the new source and drops severities.
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    const url = sentUrl(fn);
    expect(url.pathname).toBe("/api/console/logs");
    expect(url.searchParams.get("source")).toBe("postgrest_logs");
    expect(url.searchParams.get("preset")).toBe("1h");
    expect(url.searchParams.get("severities")).toBeNull();

    // PostgREST has no severity field — the pills disappear.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "warn" }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("LogsClient — query controls", () => {
  test("preset chips refetch with the chosen preset", async () => {
    const user = userEvent.setup();
    const fn = stubFetch({ entries: [ERROR_ENTRY] });
    render(<LogsClient sources={SOURCES} initialEntries={[]} />);

    await user.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(sentUrl(fn).searchParams.get("preset")).toBe("24h");

    // The fresh page replaces the table contents.
    expect(
      await screen.findByText("POST /auth/v1/token 500"),
    ).toBeInTheDocument();
  });

  test("severity pill toggles add the severities param", async () => {
    const user = userEvent.setup();
    const fn = stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[]} />);

    await user.click(screen.getByRole("button", { name: "error" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(sentUrl(fn, 0).searchParams.get("severities")).toBe("error");

    await user.click(screen.getByRole("button", { name: "warn" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(sentUrl(fn, 1).searchParams.get("severities")).toBe("error,warn");
  });

  test("search submit sends the trimmed search param", async () => {
    const user = userEvent.setup();
    const fn = stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[]} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search event message" }),
      "  templates  ",
    );
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(sentUrl(fn).searchParams.get("search")).toBe("templates");
  });

  test("a 400 answer surfaces its error as an alert, keeping the table", async () => {
    const user = userEvent.setup();
    stubFetch({ error: "severity \"bogus\" is not allowed" }, 400);
    render(<LogsClient sources={SOURCES} initialEntries={[ENTRY]} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'severity "bogus" is not allowed',
    );
    // The previous rows stay put — an error is not an empty range.
    expect(screen.getByText("GET /rest/v1/templates 200")).toBeInTheDocument();
  });

  test("a 503 unavailable answer renders the honest analytics-unavailable state", async () => {
    const user = userEvent.setup();
    stubFetch(
      { error: "analytics unreachable: token missing", unavailable: true },
      503,
    );
    render(<LogsClient sources={SOURCES} initialEntries={[ENTRY]} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Analytics unavailable")).toBeInTheDocument();
    // The table (and its stale rows) gives way to the honest state.
    expect(
      screen.queryByText("GET /rest/v1/templates 200"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LogsClient — tail polling", () => {
  test("off by default, polls every 10s when on, pauses on a hidden tab", async () => {
    vi.useFakeTimers();
    const fn = stubFetch({ entries: [] });
    render(<LogsClient sources={SOURCES} initialEntries={[]} />);

    // Default off: time passes, nothing fetches.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Tail: off" }));
    expect(
      screen.getByRole("button", { name: "Tail: on" }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sentUrl(fn).searchParams.get("source")).toBe("edge_logs");

    // Hidden tab → the ticks keep firing but never fetch.
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    // Visible again → polling resumes.
    Object.defineProperty(document, "hidden", {
      value: false,
      configurable: true,
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(fn).toHaveBeenCalledTimes(2);

    // Toggling off stops the interval.
    fireEvent.click(screen.getByRole("button", { name: "Tail: on" }));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
