import type { AppUser } from "./auth";

/**
 * Canonical Cognito group names for MarketingHub authorization.
 *
 * Deliberately NOT server-only: these are public group labels (no secrets), so
 * client components (e.g. nav filtering) may import them alongside the
 * server-side gates in `auth.ts` / `requireAdminUser.ts`.
 */

/** Baseline group: every MarketingHub user. Gates sign-in + the Marketing surfaces. */
export const MARKETING_GROUP = "marketing";

/**
 * First-sign-in auto-provisioning (2026-08-14): an ALB-verified user from
 * this Google Workspace domain who holds NO registry group gets the base
 * tier (MARKETING_GROUP) granted automatically by the /login landing — the
 * Google-side SAML app assignment is the access decision, so the manual
 * post-sign-in CLI grant is gone. Elevations (sections, admin) stay manual
 * via /admin/users. Auto-provisioning NEVER grants anything above base.
 */
export const AUTO_PROVISION_DOMAIN = "nsightcare.com";

/** The user's registry groups only — Cognito also injects a non-registry
 *  IdP group (`<pool>_GoogleSAML`) into every federated token, which must
 *  never count as "has access". */
export function registryGroupsOf(user: Pick<AppUser, "groups">): string[] {
  return user.groups.filter((g) => ALL_ASSIGNABLE_GROUPS.includes(g));
}

/** Elevated group: gates the Admin nav surfaces (auth, advisors, cloud, logs, infra). */
export const ADMIN_GROUP = "marketinghub-admins";

/**
 * Fixed section registry — the single source of truth shared by the server
 * gates (`requireSection*`), nav filtering, and the /admin/users roles UI.
 * Groups are fixed in code: granting access means Cognito group membership,
 * never a new registry entry at runtime.
 */
export const SECTIONS = [
  {
    id: "platform",
    group: "mh-section-platform",
    label: "Platform",
    description: "Console surfaces: tables, SQL, database, storage, cron, queues.",
    navGroups: ["Platform", "Integrations"],
    /** The section's landing page (its first nav item). */
    home: "/database",
  },
  {
    id: "intel",
    group: "mh-section-intel",
    label: "Competitor Intel",
    description: "Competitor-intel pages and search APIs.",
    // /intel is a single item inside the Marketing nav group (no group of its
    // own); nav filters it per-item via this section's gate.
    navGroups: [],
    home: "/intel",
  },
] as const;

export type Section = (typeof SECTIONS)[number];
export type SectionId = Section["id"];

/**
 * Every group the roles UI may grant/revoke — grants for any other group are
 * rejected server-side.
 */
export const ALL_ASSIGNABLE_GROUPS: readonly string[] = [
  MARKETING_GROUP,
  ...SECTIONS.map((s) => s.group),
  ADMIN_GROUP,
];

/** True when the user belongs to the elevated admin group. */
export function isAdmin(user: Pick<AppUser, "groups">): boolean {
  return user.groups.includes(ADMIN_GROUP);
}

/** Section check: god-mode admins pass every section; others need its group. */
export function sectionAllows(
  user: Pick<AppUser, "groups">,
  sectionId: SectionId,
): boolean {
  if (isAdmin(user)) return true;
  const section = SECTIONS.find((s) => s.id === sectionId);
  return section !== undefined && user.groups.includes(section.group);
}

/**
 * The first destination this user's groups actually admit, or null when no
 * group grants anything (awaiting access). `marketing` → /overview (the base
 * tier owns it); otherwise the first section that passes (admins pass all).
 * The /login landing keys its redirect on THIS — never on "has any group" —
 * so a section-only user can't ping-pong /login ↔ /overview forever.
 */
export function landingPathFor(user: Pick<AppUser, "groups">): string | null {
  if (user.groups.includes(MARKETING_GROUP)) return "/overview";
  const section = SECTIONS.find((s) => sectionAllows(user, s.id));
  return section?.home ?? null;
}
