import type { AppUser } from "./auth";

/**
 * Canonical Cognito group names for MarketingHub authorization.
 *
 * Deliberately NOT server-only: these are public group labels (no secrets), so
 * client components (e.g. nav filtering) may import them alongside the
 * server-side gates in `auth.ts` / `requireAdminUser.ts`.
 */

/** Baseline group: every MarketingHub user. Gates all app pages + APIs. */
export const MARKETING_GROUP = "marketing";

/** Elevated group: gates the Admin nav surfaces (auth, advisors, cloud, logs, infra). */
export const ADMIN_GROUP = "marketinghub-admins";

/** True when the user belongs to the elevated admin group. */
export function isAdmin(user: Pick<AppUser, "groups">): boolean {
  return user.groups.includes(ADMIN_GROUP);
}
