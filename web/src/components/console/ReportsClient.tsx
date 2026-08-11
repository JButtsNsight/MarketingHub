"use client";

import { useState } from "react";

import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { DataTable, type Column } from "../ui/DataTable";
import { LineChart } from "../ui/LineChart";
import { Surface } from "../Surface";
import type {
  ApiErrorRatePoint,
  ApiRequestVolumePoint,
  AuthEventPoint,
  MetricInterval,
  ServiceLogVolumePoint,
  TopRoute,
} from "@/lib/console/logs";

/**
 * The interactive shell for the Reports screen (Studio → Reports parity,
 * Wave 6). It renders the server-loaded 24h snapshot and lets the user switch
 * the time-range preset or refresh — every fetch goes through the group-gated
 * /api/console/reports route, which only serves the five canned, allowlisted
 * metrics (there is no user-defined query surface here at all).
 *
 * READ-ONLY: nothing here mutates state, so there is no confirm modal.
 *
 * Charts follow the Overview live-stats precedent: the sanctioned pure-SVG
 * LineChart primitive, one series per chart, each with a unique gradient id
 * and a fixed data-pool token (never --fail — red is reserved for failure
 * states). Identity is carried by each chart's Section title, not by hue, and
 * every figure is backed by text (StatCard totals + the top-routes table), so
 * color is never the only channel.
 */

export type ReportPreset = "1h" | "24h" | "7d";

const PRESETS: readonly ReportPreset[] = ["1h", "24h", "7d"];

const DEFAULT_PRESET: ReportPreset = "24h";

/** Preset window sizes. Must mirror the /api/console/reports PRESETS map. */
const PRESET_MS: Record<ReportPreset, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

/** Preset → bucket interval. Must mirror the /api/console/reports PRESETS map. */
const PRESET_INTERVAL: Record<ReportPreset, MetricInterval> = {
  "1h": "minute",
  "24h": "hour",
  "7d": "day",
};

/** The canned metric names the API route allowlists. */
type ReportMetricName =
  | "apiRequestVolume"
  | "apiErrorRates"
  | "authEvents"
  | "serviceLogVolume"
  | "topRoutes";

/** One metric's fetch outcome: rows on success, a display error otherwise. */
export interface SeriesState<T> {
  rows: T[] | null;
  error: string | null;
  /**
   * True when the failure was the typed "analytics unreachable" state (the
   * route's 503 + `unavailable: true`, or the server page's
   * AnalyticsUnavailableError) — never inferred from message text.
   */
  unavailable?: boolean;
}

/** The range a snapshot was computed over (ISO strings + bucket interval). */
export interface RangeMeta {
  from: string;
  to: string;
  interval: MetricInterval;
}

/** Everything the Reports page shows for one time range. */
export interface ReportsData {
  range: RangeMeta;
  volume: SeriesState<ApiRequestVolumePoint>;
  errorRates: SeriesState<ApiErrorRatePoint>;
  authEvents: SeriesState<AuthEventPoint>;
  serviceVolume: SeriesState<ServiceLogVolumePoint>;
  topRoutes: SeriesState<TopRoute>;
}

const STEP_MS: Record<MetricInterval, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Hard cap on generated slots (presets stay well under it). */
const MAX_SLOTS = 800;

/** Floor an epoch to its UTC interval boundary (what timestamp_trunc did). */
function floorToInterval(ms: number, interval: MetricInterval): number {
  return ms - (ms % STEP_MS[interval]);
}

/**
 * Zero-fill a bucketed series so the x-axis is a real, equidistant timeline:
 * generate every interval slot in the range, union in the buckets the data
 * actually returned (belt-and-braces against boundary skew), and read each
 * bucket's value with 0 as the default. Without this, quiet periods would
 * silently compress and the line would lie about time.
 */
export function fillBuckets(
  range: RangeMeta,
  totals: Map<string, number>,
): { buckets: string[]; points: number[] } {
  const slots = new Set<string>(totals.keys());
  const start = Date.parse(range.from);
  const end = Date.parse(range.to);
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    const step = STEP_MS[range.interval];
    let generated = 0;
    for (
      let t = floorToInterval(start, range.interval);
      t <= end && generated < MAX_SLOTS;
      t += step, generated += 1
    ) {
      slots.add(new Date(t).toISOString());
    }
  }
  const buckets = [...slots].sort();
  return { buckets, points: buckets.map((b) => totals.get(b) ?? 0) };
}

/** Short x-axis label for a bucket ISO string. */
function bucketLabel(iso: string, interval: MetricInterval): string {
  return interval === "day" ? iso.slice(5, 10) : iso.slice(11, 16);
}

/** First / middle / last labels for the chart's label row. */
function edgeLabels(buckets: string[], interval: MetricInterval): string[] {
  if (buckets.length === 0) return [];
  const picks =
    buckets.length >= 3
      ? [0, Math.floor(buckets.length / 2), buckets.length - 1]
      : buckets.length === 2
        ? [0, 1]
        : [0];
  return picks.map((i) => bucketLabel(buckets[i], interval));
}

/** Fold rows into a bucket → number map, summing collisions. */
function totalsBy<T>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => number,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    totals.set(k, (totals.get(k) ?? 0) + value(row));
  }
  return totals;
}

function sumBy<T>(rows: T[] | null, pick: (row: T) => number): number | null {
  if (rows == null) return null;
  return rows.reduce((total, row) => total + pick(row), 0);
}

/** Fetch one canned metric; never throws — errors land in the state. */
async function fetchMetric<T>(
  metric: ReportMetricName,
  preset: ReportPreset,
): Promise<SeriesState<T>> {
  try {
    const res = await fetch(`/api/console/reports?metric=${metric}&preset=${preset}`);
    const body = (await res.json().catch(() => null)) as
      | { rows?: T[]; error?: string; unavailable?: boolean }
      | null;
    if (!res.ok) {
      return {
        rows: null,
        error: body?.error ?? `request failed (${res.status})`,
        // The route marks the honest pre-apply/outage state with 503 +
        // `unavailable: true` (same convention as /api/console/logs).
        unavailable: res.status === 503 && body?.unavailable === true,
      };
    }
    return { rows: Array.isArray(body?.rows) ? body.rows : [], error: null };
  } catch {
    return { rows: null, error: "network error — please try again" };
  }
}

const ROUTE_COLUMNS: Column<TopRoute>[] = [
  { key: "method", header: "method", mono: true, width: "100px" },
  { key: "path", header: "path", mono: true },
  { key: "count", header: "requests", mono: true, align: "right", width: "110px" },
];

/** A titled chart panel with its own error / empty / plotted states. */
function ChartPanel({
  id,
  title,
  description,
  color,
  state,
  range,
  fold,
}: {
  id: string;
  title: string;
  description: string;
  /** A data-pool token — never --fail. */
  color: string;
  state: SeriesState<unknown>;
  range: RangeMeta;
  fold: (rows: unknown[]) => Map<string, number>;
}) {
  let body: React.ReactNode;
  if (state.rows == null) {
    body = (
      <p className="form-error" role="alert">
        {state.error ?? "query failed"}
      </p>
    );
  } else if (state.rows.length === 0) {
    body = <p className="panel-desc">No data in range.</p>;
  } else {
    const { buckets, points } = fillBuckets(range, fold(state.rows));
    body = (
      <LineChart
        id={id}
        points={points}
        color={color}
        labels={edgeLabels(buckets, range.interval)}
        ariaLabel={`${title} chart`}
      />
    );
  }
  return (
    <Section eyebrow="Analytics" title={title} description={description}>
      {body}
    </Section>
  );
}

export function ReportsClient({ initial }: { initial: ReportsData }) {
  const [data, setData] = useState(initial);
  const [preset, setPreset] = useState<ReportPreset>(DEFAULT_PRESET);
  const [loading, setLoading] = useState(false);

  const run = async (next: ReportPreset) => {
    setPreset(next);
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - PRESET_MS[next]);
      // The route recomputes its own from/to server-side; this local range
      // only drives zero-filled slot generation (union absorbs any skew).
      const range: RangeMeta = {
        from: from.toISOString(),
        to: to.toISOString(),
        interval: PRESET_INTERVAL[next],
      };
      const [volume, errorRates, auth, services, routes] = await Promise.all([
        fetchMetric<ApiRequestVolumePoint>("apiRequestVolume", next),
        fetchMetric<ApiErrorRatePoint>("apiErrorRates", next),
        fetchMetric<AuthEventPoint>("authEvents", next),
        fetchMetric<ServiceLogVolumePoint>("serviceLogVolume", next),
        fetchMetric<TopRoute>("topRoutes", next),
      ]);
      setData({
        range,
        volume,
        errorRates,
        authEvents: auth,
        serviceVolume: services,
        topRoutes: routes,
      });
    } finally {
      setLoading(false);
    }
  };

  const states: SeriesState<unknown>[] = [
    data.volume,
    data.errorRates,
    data.authEvents,
    data.serviceVolume,
    data.topRoutes,
  ];
  // Every metric hits the same Logflare endpoint — if they ALL came back
  // unreachable, the analytics route/token apply is pending (or Logflare is
  // down) and one honest page-level state beats five identical error panels.
  // Detection rides the typed `unavailable` flag (route 503 contract /
  // server AnalyticsUnavailableError), never error-message text.
  const unreachable = states.every((s) => s.unavailable === true);

  const interval = data.range.interval;
  const requests = sumBy(data.volume.rows, (r) => r.total);
  const errTotal = sumBy(data.errorRates.rows, (r) => r.total);
  const err4xx = sumBy(data.errorRates.rows, (r) => r.errors4xx);
  const errorRate =
    errTotal != null && err4xx != null && errTotal > 0
      ? `${((err4xx / errTotal) * 100).toFixed(1)}%`
      : "—";
  const authTotal = sumBy(data.authEvents.rows, (r) => r.count);
  const serviceTotal = sumBy(data.serviceVolume.rows, (r) => r.count);

  return (
    <div className="stack">
      <div className="dgrid-toolbar" role="toolbar" aria-label="Time range">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={preset === p ? "type-chip on" : "type-chip"}
            aria-pressed={preset === p}
            disabled={loading}
            onClick={() => {
              if (p !== preset) void run(p);
            }}
          >
            {p}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className="type-chip"
          disabled={loading}
          onClick={() => void run(preset)}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {unreachable ? (
        <Surface className="empty-state" glint>
          <h2>Analytics unavailable</h2>
          <p>
            Logflare did not answer through the data API — the staged W6
            analytics route/token apply is still pending, or the service is
            unreachable. Nothing else in the console is affected.
          </p>
        </Surface>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="API requests"
              value={requests ?? "—"}
              hint="via Kong edge logs"
              accent="var(--data-1)"
            />
            {/* Error rate is an attention number — text ink, no accent
                (data-pool only on StatCards; --fail is Badge-reserved). */}
            <StatCard
              label="Error rate"
              value={errorRate}
              hint="responses with status ≥ 400"
            />
            <StatCard
              label="Auth events"
              value={authTotal ?? "—"}
              hint="GoTrue log events"
              accent="var(--data-4)"
            />
            <StatCard
              label="Service log lines"
              value={serviceTotal ?? "—"}
              hint="realtime + storage"
              accent="var(--data-3)"
            />
          </div>

          {/* Charts sit two-up on wide screens (single column under 900px,
              via the shared .split-2 utility) so the page doesn't scroll
              forever; LineChart is viewBox-scaled SVG, so each chart simply
              renders at half width. The top-routes table below stays
              full-width — its path column genuinely needs the room. */}
          <div className="split-2">
            <ChartPanel
              id="rpt-requests"
              title="API request volume"
              description={`Requests through Kong per ${interval}, from the edge logs.`}
              color="var(--data-1)"
              state={data.volume}
              range={data.range}
              fold={(rows) =>
                totalsBy(
                  rows as ApiRequestVolumePoint[],
                  (r) => r.bucket,
                  (r) => r.total,
                )
              }
            />

            <ChartPanel
              id="rpt-errors"
              title="API error rate"
              description={`Percentage of edge responses with status ≥ 400 per ${interval} bucket.`}
              color="var(--data-2)"
              state={data.errorRates}
              range={data.range}
              fold={(rows) =>
                totalsBy(
                  rows as ApiErrorRatePoint[],
                  (r) => r.bucket,
                  (r) =>
                    r.total > 0
                      ? Math.round((r.errors4xx / r.total) * 1000) / 10
                      : 0,
                )
              }
            />

            <ChartPanel
              id="rpt-auth"
              title="Auth events"
              description={`GoTrue log events per ${interval}, all levels combined.`}
              color="var(--data-4)"
              state={data.authEvents}
              range={data.range}
              fold={(rows) =>
                totalsBy(
                  rows as AuthEventPoint[],
                  (r) => r.bucket,
                  (r) => r.count,
                )
              }
            />

            <ChartPanel
              id="rpt-services"
              title="Realtime & Storage log volume"
              description={`Log lines from the realtime and storage services per ${interval}, all levels combined.`}
              color="var(--data-3)"
              state={data.serviceVolume}
              range={data.range}
              fold={(rows) =>
                totalsBy(
                  rows as ServiceLogVolumePoint[],
                  (r) => r.bucket,
                  (r) => r.count,
                )
              }
            />
          </div>

          <Section
            eyebrow="Analytics"
            title="Top routes"
            description="Most-requested method + path pairs in the selected range (top 20)."
          >
            {data.topRoutes.rows == null ? (
              <p className="form-error" role="alert">
                {data.topRoutes.error ?? "query failed"}
              </p>
            ) : (
              <DataTable
                columns={ROUTE_COLUMNS}
                rows={data.topRoutes.rows}
                getRowKey={(r) => `${r.method} ${r.path}`}
                empty="No requests in range."
              />
            )}
          </Section>
        </>
      )}
    </div>
  );
}

export default ReportsClient;
