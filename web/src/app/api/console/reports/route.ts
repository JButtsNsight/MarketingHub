import { AuthError, requireUser } from "@/lib/auth";
import { MARKETING_GROUP } from "@/lib/authGroups";
import {
  AnalyticsUnavailableError,
  apiErrorRates,
  apiRequestVolume,
  authEvents,
  serviceLogVolume,
  topRoutes,
  type MetricInterval,
} from "@/lib/console/logs";

/**
 * Supabase-parity Reports metrics: serves the five CANNED Logflare metrics
 * (edge request volume, edge error rates, top routes, auth events,
 * realtime/storage log volume), gated on the base `marketing` group (the
 * Wave D role model keeps Reports in the marketing tier, not `platform`).
 *
 * READ-ONLY — the only verb is GET, and there are NO user-defined queries:
 * `metric` must be one of the allowlisted names below and `preset` one of the
 * three fixed windows; from/to are computed server-side and the SQL lives as
 * fixed templates in the foundation lib.
 *
 * Failure mapping — SAME convention as /api/console/logs:
 *   - AnalyticsUnavailableError (token not staged / Kong route not enabled /
 *     Logflare down / network / timeout) → 503 with `unavailable: true`, so
 *     clients and monitors see a service-side condition (5xx), never a 400.
 *   - Other `[console:logs] …` lib failures → 400 with the stripped message
 *     (the standard consoleAttempt convention, like /api/console/advisors).
 */

export const dynamic = "force-dynamic";

/** Fixed windows; each carries its bucket interval. Mirrored in ReportsClient. */
const PRESETS: Record<string, { ms: number; interval: MetricInterval }> = {
  "1h": { ms: 3_600_000, interval: "minute" },
  "24h": { ms: 86_400_000, interval: "hour" },
  "7d": { ms: 604_800_000, interval: "day" },
};

const DEFAULT_PRESET = "24h";

/** The one knob topRoutes has, fixed server-side (lib clamps to 100 anyway). */
const TOP_ROUTES_LIMIT = 20;

/** Metric-name allowlist → the canned foundation-lib call it runs. */
const METRICS: Record<
  string,
  (from: Date, to: Date, interval: MetricInterval) => Promise<unknown[]>
> = {
  apiRequestVolume: (from, to, interval) =>
    apiRequestVolume({ from, to, interval }),
  apiErrorRates: (from, to, interval) => apiErrorRates({ from, to, interval }),
  topRoutes: (from, to) => topRoutes({ from, to, limit: TOP_ROUTES_LIMIT }),
  authEvents: (from, to, interval) => authEvents({ from, to, interval }),
  serviceLogVolume: (from, to, interval) =>
    serviceLogVolume({ from, to, interval }),
};

const METRIC_NAMES = Object.keys(METRICS);

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * Foundation-lib failures (`[console:<area>] …`) are 400s; the unreachable
 * class maps to an honest 503 + `unavailable` flag FIRST (its message also
 * starts with "[console:" — order matters).
 */
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof AnalyticsUnavailableError) {
      return Response.json(
        {
          error: err.message.replace(/^\[console:logs\] /, ""),
          unavailable: true,
        },
        { status: 503 },
      );
    }
    if (err instanceof Error && err.message.startsWith("[console:")) {
      return Response.json(
        {
          error: err.message.replace(
            /^\[console:[\w-]+\] (?:[\w-]+ failed: )?/,
            "",
          ),
        },
        { status: 400 },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const params = new URL(req.url).searchParams;

  // `metric` is required and must be an allowlisted name. Object.hasOwn keeps
  // prototype names (constructor, …) from sneaking past the record lookup.
  const metric = params.get("metric");
  if (metric == null || metric === "" || !Object.hasOwn(METRICS, metric)) {
    return Response.json(
      { error: `metric must be one of ${METRIC_NAMES.join(", ")}` },
      { status: 400 },
    );
  }

  // Optional `preset`; absent/empty means the default window.
  const rawPreset = params.get("preset");
  const preset = rawPreset == null || rawPreset === "" ? DEFAULT_PRESET : rawPreset;
  if (!Object.hasOwn(PRESETS, preset)) {
    return Response.json(
      { error: `preset must be one of ${Object.keys(PRESETS).join(", ")}` },
      { status: 400 },
    );
  }

  const { ms, interval } = PRESETS[preset];
  const to = new Date();
  const from = new Date(to.getTime() - ms);

  const rows = await consoleAttempt(() => METRICS[metric](from, to, interval));
  if (rows instanceof Response) return rows;

  return Response.json({
    metric,
    preset,
    interval,
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
  });
}
