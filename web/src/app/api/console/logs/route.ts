import { AuthError } from "@/lib/auth";
import { requireAdminApi } from "@/lib/requireAdminUser";
import {
  AnalyticsUnavailableError,
  LOG_SOURCES,
  queryLogs,
} from "@/lib/console/logs";

/**
 * Logs explorer query route (Wave 6 Logflare observability). READ-ONLY: GET is
 * the only verb, gated on the `marketinghub-admins` Cognito group (Admin nav
 * surface; non-admins get a 403 `admin-only`).
 *
 * Every input is validated against the foundation lib's own allowlists
 * (LOG_SOURCES ids + per-source severity values) before anything runs, and the
 * time range is resolved SERVER-SIDE from a fixed preset — the browser never
 * supplies timestamps, SQL, or anything structural. The lib then builds the
 * actual Logflare query from fixed templates only.
 *
 * Failure mapping:
 *   - AnalyticsUnavailableError (token not staged / Kong route not enabled /
 *     network / timeout) → 503 with `unavailable: true` so the client renders
 *     the honest "Analytics unavailable" state, never a generic error.
 *   - `[console:logs] …` lib failures → 400 with the stripped message (the
 *     standard consoleAttempt convention).
 */

export const dynamic = "force-dynamic";

/**
 * Fixed time-range presets (mirrors the LogsClient chips). from/to are
 * computed here so the client never sends timestamps.
 */
const PRESET_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    // 403 body is the fixed "admin-only" marker; 401 keeps the lib's message.
    return Response.json(
      { error: err.status === 403 ? "admin-only" : err.message },
      { status: err.status },
    );
  }
  throw err;
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Foundation-lib failures (`[console:logs] <op> failed: <msg>`) are 400s;
 * the unreachable class maps to an honest 503 + `unavailable` flag FIRST
 * (its message also starts with "[console:" — order matters).
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
    // Token gate + live pool check (60s cache) — a revoked admin loses this
    // API near-instantly, not at token expiry.
    await requireAdminApi(req.headers);
  } catch (err) {
    return authErrorResponse(err);
  }

  const params = new URL(req.url).searchParams;

  // source — must be one of the lib's static allowlist ids.
  const sourceId = params.get("source") ?? "";
  const source = LOG_SOURCES.find((entry) => entry.id === sourceId);
  if (!source) {
    return badRequest(
      `source must be one of ${LOG_SOURCES.map((entry) => entry.id).join(", ")}`,
    );
  }

  // preset — resolved to from/to here; absent defaults to the page's 1h.
  const presetRaw = params.get("preset") ?? "1h";
  const presetMs = PRESET_MS[presetRaw];
  if (presetMs === undefined) {
    return badRequest(
      `preset must be one of ${Object.keys(PRESET_MS).join(", ")}`,
    );
  }

  // severities — comma-separated, each value checked against the source's own
  // allowlist (sources without a severity field accept none at all).
  let severities: string[] | undefined;
  const severitiesRaw = params.get("severities");
  if (severitiesRaw != null && severitiesRaw !== "") {
    const values = severitiesRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const allowed = source.severity?.values;
    if (!allowed) {
      return badRequest(
        `source "${source.id}" does not support severity filtering`,
      );
    }
    for (const value of values) {
      if (!allowed.includes(value)) {
        return badRequest(
          `severity "${value.slice(0, 40)}" is not allowed for ${source.id} ` +
            `(allowed: ${allowed.join(", ")})`,
        );
      }
    }
    if (values.length > 0) severities = values;
  }

  // search — free text, but bounded here exactly as the lib binds it (≤200
  // chars, no backslashes/control characters; the lib escapes the rest into a
  // LIKE literal — search is never structural).
  let search: string | undefined;
  const searchRaw = params.get("search");
  if (searchRaw != null && searchRaw !== "") {
    if (searchRaw.length > 200) {
      return badRequest("search must be at most 200 characters");
    }
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(searchRaw)) {
      return badRequest(
        "search may not contain backslashes or control characters",
      );
    }
    search = searchRaw;
  }

  // limit — must be an integer; the lib clamps it into [1, 1000].
  let limit: number | undefined;
  const limitRaw = params.get("limit");
  if (limitRaw != null && limitRaw !== "") {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed)) {
      return badRequest("limit must be an integer");
    }
    limit = parsed;
  }

  const to = new Date();
  const from = new Date(to.getTime() - presetMs);

  const entries = await consoleAttempt(() =>
    queryLogs({ source: source.id, search, severities, from, to, limit }),
  );
  if (entries instanceof Response) return entries;
  return Response.json({ entries });
}
