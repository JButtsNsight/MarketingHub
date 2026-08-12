import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, requireUser, type AppUser, type HeaderSource } from "./auth";
import { ADMIN_GROUP } from "./authGroups";
import { liveGroupsFor } from "./cognitoAdmin";

/**
 * Discriminated result so pages can render a 403 panel instead of redirecting:
 * a signed-in non-admin bouncing to `/login` would feel like a redirect loop
 * (they ARE logged in — they just lack the group).
 */
export type AdminGate = { ok: true; user: AppUser } | { ok: false };

/**
 * Server-component auth gate for the Admin nav surfaces.
 *
 * Like `requireMarketingUser`, but checks the elevated `marketinghub-admins`
 * group and NEVER redirects a signed-in user to `/login`. Callers branch on the
 * discriminant:
 *
 *   const gate = await requireAdminUser();
 *   if (!gate.ok) return <ForbiddenPanel />;   // terse 403, still signed in
 *   const user = gate.user;
 *
 * Signed-OUT users (401) still go to `/login`; `redirect()` throws internally,
 * so callers never proceed past it.
 *
 * Near-instant revocation: after the token check passes, the CURRENT pool
 * groups are consulted (`liveGroupsFor`, 60s cache). REVOCATION-ONLY — a live
 * answer can only demote (ADMIN_GROUP gone → non-admin); it never grants what
 * the token lacks (non-admin tokens 403 above without consulting the pool).
 * A live-check failure returns null and the token verdict stands (fail-open,
 * logged loud in cognitoAdmin — an ALB session must survive a Cognito blip).
 */
export async function requireAdminUser(): Promise<AdminGate> {
  try {
    return { ok: true, user: await requireAdminApi(await headers()) };
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.status === 401) redirect("/login");
      return { ok: false }; // signed in, not an admin (or revoked since sign-in)
    }
    throw err;
  }
}

/**
 * Route-handler twin of `requireAdminUser` for EVERY admin-gated API: token
 * gate first, then the same live pool check, throwing `AuthError` (401
 * unauthenticated, 403 non-admin or revoked) for callers that map status to
 * an HTTP response. `fresh: true` bypasses the 60s live cache — mutation
 * endpoints (grants) use it so an OUT-OF-BAND revocation (AWS console/CLI)
 * can't ride a warm cache into a self-re-grant; reads keep the cached check.
 */
export async function requireAdminApi(
  requestHeaders: HeaderSource,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<AppUser> {
  const user = await requireUser(requestHeaders, ADMIN_GROUP);
  // Positional undefined = the lib's own (memoized) Cognito client.
  const live = await liveGroupsFor(user.email, undefined, { fresh });
  if (live !== null && !live.includes(ADMIN_GROUP)) {
    throw new AuthError(403, "admin group revoked since sign-in");
  }
  return user;
}
