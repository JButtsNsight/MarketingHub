import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, requireUser, type AppUser } from "./auth";
import { ADMIN_GROUP } from "./authGroups";

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
 */
export async function requireAdminUser(): Promise<AdminGate> {
  try {
    return { ok: true, user: await requireUser(await headers(), ADMIN_GROUP) };
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.status === 401) redirect("/login");
      return { ok: false }; // signed in, not an admin
    }
    throw err;
  }
}
