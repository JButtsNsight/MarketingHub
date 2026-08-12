import { AuthError } from "@/lib/auth";
import { requireAdminApi } from "@/lib/requireAdminUser";
import { groupsForUser, listPoolUsers, type PoolUser } from "@/lib/cognitoAdmin";

/**
 * Cognito pool users + their groups (Wave D Users & Roles). READ side of the
 * /admin/users surface: GET is the only exported verb (grants go through
 * /api/console/cognito/grants). Gated on the `marketinghub-admins` group with
 * the SAME live pool check as `requireAdminUser` — revocation-only: a live
 * answer can demote a stale admin token, never promote a non-admin one, and a
 * pool blip keeps the token verdict (fail-open, logged loud in cognitoAdmin).
 *
 * Any pool failure here (env unset, Cognito down/throttled) maps to an honest
 * 503 + `unavailable: true` — the client renders "pool unreachable", never a
 * fake-empty user list (the gotrue/users convention).
 */

export const dynamic = "force-dynamic";

/** One pool user with the group memberships the roles UI toggles. */
export interface RoleUser extends PoolUser {
  groups: string[];
}

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

export async function GET(req: Request): Promise<Response> {
  try {
    // Token gate + live pool check (60s cache) — a revoked admin loses this
    // API near-instantly.
    await requireAdminApi(req.headers);
  } catch (err) {
    return authErrorResponse(err);
  }

  try {
    const users = await listPoolUsers();
    // N+1 by design: the foundation exposes per-user group listing and the
    // pool is company-sized; parallel sends keep the render path short.
    const withGroups: RoleUser[] = await Promise.all(
      users.map(async (u) => ({ ...u, groups: await groupsForUser(u.username) })),
    );
    return Response.json({ users: withGroups });
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: "cognito pool user list failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "Cognito pool did not answer.", unavailable: true },
      { status: 503 },
    );
  }
}
