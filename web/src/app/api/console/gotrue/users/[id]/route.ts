import { AuthError, requireUser } from "@/lib/auth";
import { GoTrueUnavailableError, getUser } from "@/lib/console/gotrue";

/**
 * GoTrue admin single-user detail — the eager-loaded row behind the Users
 * table's expand control (identities + MFA factors + metadata, which the
 * list endpoint deliberately does not carry). READ-ONLY BY DESIGN: GET is
 * the only exported verb — Next answers 405 for everything else — and this
 * surface must never grow the PUT/DELETE that GoTrue exposes upstream (hard
 * Wave 3-partial program constraint). Gated on the `marketing` Cognito
 * group like every console route.
 *
 * Failure mapping:
 *   - GoTrueUnavailableError → 503 + `unavailable: true` (honest state).
 *   - `[console:gotrue] …` failures → 400 with the stripped message. A 404
 *     from GoTrue (user_not_found, or validation_failed for non-UUID ids)
 *     is a REAL answer under the always-enabled auth-v1 route, so it
 *     surfaces through this path — never as unavailable.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Path ids longer than this cannot name a user; refuse before any fetch. */
const ID_MAX_CHARS = 100;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
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

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed === "" || trimmed.length > ID_MAX_CHARS) {
    return Response.json(
      { error: "id must be a non-empty user id" },
      { status: 400 },
    );
  }

  // The lib percent-encodes the id into the path; a non-UUID comes back from
  // GoTrue as 404 validation_failed, which maps to a 400 here — a real
  // answer, never treated as unavailable.
  const user = await consoleAttempt(() => getUser(trimmed));
  if (user instanceof Response) return user;

  return Response.json({ user });
}
