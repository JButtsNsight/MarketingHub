import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, requireUser, type AppUser } from "./auth";

/** Cognito group required to view the campaign-template library. */
export const MARKETING_GROUP = "marketing";

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
    return requireUser(await headers(), MARKETING_GROUP);
  } catch (err) {
    if (err instanceof AuthError) redirect("/login");
    throw err;
  }
}
