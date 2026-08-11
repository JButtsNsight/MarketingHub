import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, requireUser, type AppUser } from "./auth";
import { MARKETING_GROUP } from "./authGroups";

/** Re-exported for existing importers; the canonical home is `authGroups.ts`. */
export { MARKETING_GROUP };

/**
 * Server-component auth gate for the marketing template pages.
 *
 * The API route handlers gate every read on the `marketing` Cognito group, but
 * the browse/detail pages fetch server-side through the service-role repo and
 * never route through the API — so the gate must be enforced here too, or any
 * authenticated NSight employee (the ALB federates the whole Google Workspace)
 * could read the library without belonging to `marketing`.
 *
 * On any `AuthError` (unauthenticated or missing the group) it redirects to the
 * `/login` fallback; `redirect()` throws internally, so callers never proceed.
 */
export async function requireMarketingUser(): Promise<AppUser> {
  try {
    // `await` is required: without it a rejected requireUser() promise would
    // escape this try/catch and skip the /login redirect below.
    return await requireUser(await headers(), MARKETING_GROUP);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }
}
