import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ReportsClient,
  fillBuckets,
  type ReportsData,
  type SeriesState,
} from "./ReportsClient";

const RANGE = {
  from: "2026-08-07T00:00:00.000Z",
  to: "2026-08-08T00:00:00.000Z",
  interval: "hour" as const,
};

function ok<T>(rows: T[]): SeriesState<T> {
  return { rows, error: null };
}

/** A healthy 24h snapshot with distinct, assertable totals. */
function snapshot(overrides: Partial<ReportsData> = {}): ReportsData {
  return {
    range: RANGE,
    volume: ok([
      {
        bucket: "2026-08-07T10:00:00.000Z",
        total: 5,
        rest: 3,
        auth: 1,
        storage: 1,
        realtime: 0,
        functions: 0,
      },
      {
        bucket: "2026-08-07T11:00:00.000Z",
        total: 7,
        rest: 6,
        auth: 0,
        storage: 0,
        realtime: 1,
        functions: 0,
      },
    ]),
    errorRates: ok([
      {
        bucket: "2026-08-07T10:00:00.000Z",
        total: 10,
        errors4xx: 2,
        errors5xx: 1,
      },
    ]),
    authEvents: ok([
      { bucket: "2026-08-07T10:00:00.000Z", level: "info", count: 3 },
      { bucket: "2026-08-07T11:00:00.000Z", level: "error", count: 1 },
    ]),
    serviceVolume: ok([
      {
        bucket: "2026-08-07T10:00:00.000Z",
        service: "realtime" as const,
        level: "info",
        count: 2,
      },
      {
        bucket: "2026-08-07T11:00:00.000Z",
        service: "storage" as const,
        level: "warn",
        count: 3,
      },
    ]),
    topRoutes: ok([{ method: "GET", path: "/rest/v1/foo", count: 42 }]),
    ...overrides,
  };
}

/** Route-shaped fetch mock: answers each metric from the given map. */
function mockReportsFetch(rowsByMetric: Record<string, unknown[]>) {
  const urls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    urls.push(url);
    const metric = new URL(url, "http://x").searchParams.get("metric") ?? "";
    return Promise.resolve(
      new Response(JSON.stringify({ rows: rowsByMetric[metric] ?? [] }), {
        status: 200,
      }),
    );
  });
  vi.stubGlobal("fetch", fn);
  return { fn, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fillBuckets", () => {
  test("zero-fills every interval slot across the range", () => {
    const { buckets, points } = fillBuckets(
      {
        from: "2026-08-08T10:00:00.000Z",
        to: "2026-08-08T13:00:00.000Z",
        interval: "hour",
      },
      new Map([["2026-08-08T11:00:00.000Z", 6]]),
    );
    expect(buckets).toEqual([
      "2026-08-08T10:00:00.000Z",
      "2026-08-08T11:00:00.000Z",
      "2026-08-08T12:00:00.000Z",
      "2026-08-08T13:00:00.000Z",
    ]);
    expect(points).toEqual([0, 6, 0, 0]);
  });

  test("keeps data buckets that fall outside the generated slots", () => {
    const { buckets, points } = fillBuckets(
      {
        from: "2026-08-08T10:00:00.000Z",
        to: "2026-08-08T11:00:00.000Z",
        interval: "hour",
      },
      new Map([["2026-08-08T09:00:00.000Z", 4]]),
    );
    expect(buckets[0]).toBe("2026-08-08T09:00:00.000Z");
    expect(points[0]).toBe(4);
  });
});

describe("ReportsClient", () => {
  test("renders totals, four charts, and the top-routes table from the series", () => {
    render(<ReportsClient initial={snapshot()} />);

    // StatCard totals: 5+7 requests, 2/10 errors, 3+1 auth, 2+3 service lines.
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("20.0%")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();

    // One single-series SVG chart per metric, each named for its section.
    expect(screen.getByRole("img", { name: "API request volume chart" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "API error rate chart" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Auth events chart" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Realtime & Storage log volume chart" }),
    ).toBeInTheDocument();

    // Top routes table rows.
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("/rest/v1/foo")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  test("shows a per-chart empty state when a series has no rows in range", () => {
    render(
      <ReportsClient
        initial={snapshot({
          volume: ok([]),
          errorRates: ok([]),
          authEvents: ok([]),
          serviceVolume: ok([]),
          topRoutes: ok([]),
        })}
      />,
    );

    expect(screen.getAllByText("No data in range.")).toHaveLength(4);
    expect(screen.getByText("No requests in range.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("shows a per-chart error state without hiding the healthy charts", () => {
    render(
      <ReportsClient
        initial={snapshot({
          volume: { rows: null, error: "translator exploded" },
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("translator exploded");
    expect(
      screen.queryByRole("img", { name: "API request volume chart" }),
    ).not.toBeInTheDocument();
    // The other three still plot.
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  test("degrades to the page-level state when every metric is unreachable", () => {
    const down: SeriesState<never> = {
      rows: null,
      error: "analytics unreachable: Kong returned 404",
      unavailable: true,
    };
    render(
      <ReportsClient
        initial={snapshot({
          volume: down,
          errorRates: down,
          authEvents: down,
          serviceVolume: down,
          topRoutes: down,
        })}
      />,
    );

    expect(screen.getByText("Analytics unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a PARTIALLY unreachable snapshot keeps the healthy charts (no page-level state)", () => {
    render(
      <ReportsClient
        initial={snapshot({
          volume: {
            rows: null,
            error: "analytics unreachable: timed out after 30000 ms",
            unavailable: true,
          },
        })}
      />,
    );

    expect(screen.queryByText("Analytics unavailable")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/analytics unreachable/);
    // The other three charts still plot.
    expect(screen.getAllByRole("img")).toHaveLength(3);
  });

  test("detection rides the unavailable flag, not error-message wording", () => {
    // A message that HAPPENS to start with the old prefix must not trigger
    // the page-level state without the typed flag.
    const textOnly: SeriesState<never> = {
      rows: null,
      error: "analytics unreachable: some reworded message",
    };
    render(
      <ReportsClient
        initial={snapshot({
          volume: textOnly,
          errorRates: textOnly,
          authEvents: textOnly,
          serviceVolume: textOnly,
          topRoutes: textOnly,
        })}
      />,
    );

    expect(screen.queryByText("Analytics unavailable")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  test("a refresh where every metric answers 503+unavailable flips to the page-level state", async () => {
    const fn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "analytics unreachable: token missing",
            unavailable: true,
          }),
          { status: 503 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fn);
    const user = userEvent.setup();
    render(<ReportsClient initial={snapshot()} />);

    await user.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(5));

    expect(
      await screen.findByText("Analytics unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("switching the preset refetches all five canned metrics and re-renders", async () => {
    const { fn, urls } = mockReportsFetch({
      apiRequestVolume: [
        {
          bucket: "2026-08-05T00:00:00.000Z",
          total: 99,
          rest: 99,
          auth: 0,
          storage: 0,
          realtime: 0,
          functions: 0,
        },
      ],
    });
    const user = userEvent.setup();
    render(<ReportsClient initial={snapshot()} />);

    await user.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() => expect(fn).toHaveBeenCalledTimes(5));
    expect(urls.every((u) => u.includes("preset=7d"))).toBe(true);
    const metrics = urls
      .map((u) => new URL(u, "http://x").searchParams.get("metric"))
      .sort();
    expect(metrics).toEqual([
      "apiErrorRates",
      "apiRequestVolume",
      "authEvents",
      "serviceLogVolume",
      "topRoutes",
    ]);

    // The new series landed: total updates from 12 to 99.
    await waitFor(() => expect(screen.getByText("99")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("browsing presets never issues a write (GET only)", async () => {
    const { fn } = mockReportsFetch({});
    const user = userEvent.setup();
    render(<ReportsClient initial={snapshot()} />);

    await user.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(5));

    for (const call of fn.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? "GET").toBe("GET");
    }
  });
});
