import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, requireUser, type AppUser, type HeaderSource } from "./auth";
import { SECTIONS, sectionAllows, type SectionId } from "./authGroups";

/**
 * Discriminated result (the `requireAdminUser` shape) so pages render a 403
 * panel instead of bouncing a signed-in user to `/login`.
 */
export type SectionGate = { ok: true; user: AppUser } | { ok: false };

/** The Cognito group backing a section id (for the 403 message). */
function sectionGroup(sectionId: SectionId): string {
  return SECTIONS.find((s) => s.id === sectionId)?.group ?? sectionId;
}

/**
 * Server-component gate for a console section's PAGES. Admins (god-mode) pass
 * every section; everyone else needs the section's Cognito group. Signed-OUT
 * users go to `/login` (`redirect()` throws internally); signed-in users
 * without the section get `{ ok: false }` — callers render a 403 panel.
 */
export async function requireSectionUser(
  sectionId: SectionId,
): Promise<SectionGate> {
  try {
    const user = await requireUser(await headers());
    return sectionAllows(user, sectionId) ? { ok: true, user } : { ok: false };
  } catch (err) {
    if (err instanceof AuthError) {
      if (err.status === 401) redirect("/login");
      return { ok: false };
    }
    throw err;
  }
}

/**
 * Route-handler gate for a console section's APIs. Same policy as
 * `requireSectionUser`, but throws `AuthError` (401 unauthenticated, 403
 * missing the section) for callers that map status to an HTTP response.
 */
export async function requireSectionApi(
  requestHeaders: HeaderSource,
  sectionId: SectionId,
): Promise<AppUser> {
  const user = await requireUser(requestHeaders);
  if (!sectionAllows(user, sectionId)) {
    throw new AuthError(403, `Requires Cognito group: ${sectionGroup(sectionId)}`);
  }
  return user;
}
