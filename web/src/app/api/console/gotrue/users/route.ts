import { AuthError, requireUser } from "@/lib/auth";
import { GoTrueUnavailableError, listUsers } from "@/lib/console/gotrue";

/**
 * GoTrue admin user list (Wave 3-partial read-only console views). READ-ONLY
 * BY DESIGN: GET is the only exported verb — Next answers 405 for everything
 * else — and this surface must never grow a mutation (no create/invite/ban/
 * delete; hard Wave 3-partial program constraint). Gated on the `marketing`
 * Cognito group like every console route.
 *
 * Every query param is validated HERE before the lib is called:
 *   - page      optional positive integer (default 1)
 *   - per_page  optional integer in [1, 100] (default 50)
 *   - filter    optional substring (≤200 chars) — GoTrue matches it against
 *               email / user_metadata full_name; the only search that exists
 *   - sort      optional "asc" | "desc" on created_at (default desc) — the
 *               only sortable field at the pinned GoTrue v2.186.0
 *
 * Failure mapping:
 *   - GoTrueUnavailableError (env missing / network / timeout / 502-504
 *     behind Kong) → 503 with `unavailable: true` so the client renders the
 *     honest "GoTrue unreachable" state, never a generic error.
 *   - `[console:gotrue] …` lib failures (incl. 403 not_admin key misconfig)
 *     → 400 with the stripped message (the standard consoleAttempt
 *     convention).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Mirrors the lib's clamps so a bad request 400s instead of being coerced. */
const PER_PAGE_MAX = 100;
const FILTER_MAX_CHARS = 200;
const SORT_DIRECTIONS = ["asc", "desc"] as const;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Foundation-lib failures (`[console:gotrue] <op> failed: <msg>`) are 400s;
 * the unreachable class maps to an honest 503 + `unavailable` flag FIRST
 * (its message also starts with "[console:" — order matters).
 */
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof GoTrueUnavailableError) {
      return Response.json(
        {
          error: err.message.replace(/^\[console:gotrue\] /, ""),
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

/** Parse an optional integer param; NaN/float/out-of-range → null. */
function intParam(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const params = new URL(req.url).searchParams;

  // page — 1-based positive integer.
  let page: number | undefined;
  const pageRaw = params.get("page");
  if (pageRaw != null && pageRaw !== "") {
    const parsed = intParam(pageRaw, 1, 1_000_000);
    if (parsed === null) {
      return badRequest("page must be a positive integer");
    }
    page = parsed;
  }

  // per_page — bounded exactly as the lib clamps it, so the client can trust
  // that what it asked for is what ran.
  let perPage: number | undefined;
  const perPageRaw = params.get("per_page");
  if (perPageRaw != null && perPageRaw !== "") {
    const parsed = intParam(perPageRaw, 1, PER_PAGE_MAX);
    if (parsed === null) {
      return badRequest(`per_page must be an integer between 1 and ${PER_PAGE_MAX}`);
    }
    perPage = parsed;
  }

  // filter — free text bounded here exactly as the lib caps it; blank is
  // treated as absent (the lib omits it from the upstream query).
  let filter: string | undefined;
  const filterRaw = params.get("filter");
  if (filterRaw != null && filterRaw !== "") {
    if (filterRaw.length > FILTER_MAX_CHARS) {
      return badRequest(`filter must be at most ${FILTER_MAX_CHARS} characters`);
    }
    if (filterRaw.trim() !== "") filter = filterRaw.trim();
  }

  // sort — created_at direction only (the only sortable field at the pin).
  let sort: (typeof SORT_DIRECTIONS)[number] | undefined;
  const sortRaw = params.get("sort");
  if (sortRaw != null && sortRaw !== "") {
    if (!SORT_DIRECTIONS.includes(sortRaw as (typeof SORT_DIRECTIONS)[number])) {
      return badRequest(`sort must be one of ${SORT_DIRECTIONS.join(", ")}`);
    }
    sort = sortRaw as (typeof SORT_DIRECTIONS)[number];
  }

  const result = await consoleAttempt(() =>
    listUsers({ page, perPage, filter, sort }),
  );
  if (result instanceof Response) return result;

  // NOTE: list rows are NOT eager-loaded upstream — identities is null and
  // factors is absent on every row; the client uses /users/{id} for those.
  return Response.json({ users: result.users, total: result.total });
}
