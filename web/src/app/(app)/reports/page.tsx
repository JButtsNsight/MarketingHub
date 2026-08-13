import { PageHeader } from "@/components/ui/PageHeader";
import { Surface } from "@/components/Surface";
import { Guide } from "@/components/guide/Guide";
import { requireMarketingUser } from "@/lib/requireMarketingUser";
import {
  AnalyticsUnavailableError,
  apiErrorRates,
  apiRequestVolume,
  authEvents,
  serviceLogVolume,
  topRoutes,
} from "@/lib/console/logs";
import {
  ReportsClient,
  type ReportsData,
  type SeriesState,
} from "@/components/console/ReportsClient";

// Reads request-time identity + live Logflare metrics; never prerender.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reports · MarketingHub",
};

/** The initial load matches the client's default preset (24h / hourly). */
const INITIAL_WINDOW_MS = 86_400_000;
const INITIAL_INTERVAL = "hour" as const;
/** Same cap the API route applies. */
const TOP_ROUTES_LIMIT = 20;

/** Display form of a lib error (strip the machine "[console:logs] " prefix). */
function displayError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message.replace(/^\[console:[\w-]+\] (?:[\w-]+ failed: )?/, "");
  }
  return "query failed";
}

function toState<T>(result: PromiseSettledResult<T[]>): SeriesState<T> {
  if (result.status === "fulfilled") {
    return { rows: result.value, error: null };
  }
  return {
    rows: null,
    error: displayError(result.reason),
    // Mirrors the API route's 503 + `unavailable` flag so the client's
    // page-level degradation check works identically on server-loaded data.
    unavailable: result.reason instanceof AnalyticsUnavailableError,
  };
}

/**
 * Reports — the console's parity for Supabase Studio's observability charts,
 * computed from the five canned Logflare metrics (edge request volume, edge
 * error rates, auth events, realtime/storage log volume, top routes). Every
 * query is a fixed allowlisted template in the foundation lib — no user SQL
 * ever reaches Logflare, and the whole surface is READ-ONLY.
 *
 * Until the operator applies the staged W6 Kong-route + token steps, the lib
 * throws AnalyticsUnavailableError and this page renders its honest
 * "Analytics unavailable" state (the advisors-page degradation precedent).
 */
export default async function ReportsPage() {
  // Base marketing tier (the Wave D role model keeps Reports in it); mirrors
  // the /api/console/reports handler.
  await requireMarketingUser();

  const to = new Date();
  const from = new Date(to.getTime() - INITIAL_WINDOW_MS);
  const range = { from, to, interval: INITIAL_INTERVAL };

  const [volume, errors, auth, services, routes] = await Promise.allSettled([
    apiRequestVolume(range),
    apiErrorRates(range),
    authEvents(range),
    serviceLogVolume(range),
    topRoutes({ from, to, limit: TOP_ROUTES_LIMIT }),
  ]);

  // Page-level degradation ONLY when ALL five queries came back unreachable
  // (route/token apply pending, Logflare fully down) — the same all-five
  // threshold ReportsClient applies after a client-side refresh. A PARTIAL
  // failure (e.g. one query hitting the 30s abort) keeps the healthy charts
  // and degrades to per-chart error panels instead of hiding real data.
  const unreachable = [volume, errors, auth, services, routes].every(
    (r) =>
      r.status === "rejected" && r.reason instanceof AnalyticsUnavailableError,
  );
  if (unreachable) {
    return (
      <>
        <Guide id="observability.reports.page">
          <PageHeader title="Reports" />
        </Guide>
        <Guide id="observability.reports.unavailable">
          <Surface className="empty-state" glint>
            <h2>Analytics unavailable</h2>
            <p>
              Logflare did not answer through the data API — nothing else is
              affected.
            </p>
          </Surface>
        </Guide>
      </>
    );
  }

  const initial: ReportsData = {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      interval: INITIAL_INTERVAL,
    },
    volume: toState(volume),
    errorRates: toState(errors),
    authEvents: toState(auth),
    serviceVolume: toState(services),
    topRoutes: toState(routes),
  };

  return (
    <>
      <Guide id="observability.reports.page">
        <PageHeader title="Reports" />
      </Guide>
      <ReportsClient initial={initial} />
    </>
  );
}
