"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SECTIONS, type SectionId } from "@/lib/authGroups";
import { Surface } from "./Surface";

export type IconKey =
  | "overview"
  | "tableEditor"
  | "database"
  | "sql"
  | "storage"
  | "templates"
  | "campaigns"
  | "inbox"
  | "review"
  | "suppressions"
  | "intel"
  | "edgeFunctions"
  | "realtime"
  | "api"
  | "advisors"
  | "reports"
  | "logs"
  | "cron"
  | "queues"
  | "vault"
  | "infra"
  | "auth"
  | "cloud"
  | "settings";

export interface NavItem {
  href: string;
  label: string;
  icon: IconKey;
  /** Active on the exact path only — for an item whose route is a prefix of a
   *  sibling's (Table Editor `/database` vs. the Database section under it). */
  exact?: boolean;
  /** Overrides the active-scope prefix when it differs from `href` — the
   *  Database section lands on `/database/schema` but owns the whole
   *  `/database/` subtree (Schema + Policies). */
  match?: string;
  /** Section gating this single item (whole nav groups gate via the SECTIONS
   *  registry's `navGroups`; this is for a sectioned item inside an unrelated
   *  group, like Competitor Intel inside Marketing). */
  section?: SectionId;
  /** Item gated by the base `marketing` tier (requireMarketingUser routes) —
   *  hidden when the user lacks the group, so the rail never advertises a
   *  marketing surface that would bounce a section-only user. */
  marketing?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Console information architecture. The platform group mirrors Supabase
 * Studio's nav — same item names, same order (Table Editor, SQL Editor,
 * Database, Storage, Edge Functions, Realtime, API Docs) — so it reads 1:1
 * to anyone who knows Studio, with ONE deliberate deviation: Authentication
 * and Advisors live in their own Admin group (/admin/*), not in the platform
 * group. The marketing product and project/ops items follow in their own
 * groups (Studio has no equivalent). /admin itself is a redirect, not a
 * destination — the Admin group lists its pages directly.
 */
export const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: "/overview", label: "Overview", icon: "overview", marketing: true }] },
  {
    label: "Platform",
    items: [
      // /database is the grid (Table Editor); /database/schema is the
      // Database section — distinct nav items over nested routes, resolved by
      // the most-specific-match rule in isActive below.
      { href: "/database", label: "Table Editor", icon: "tableEditor", exact: true },
      { href: "/sql", label: "SQL Editor", icon: "sql" },
      {
        href: "/database/schema",
        label: "Database",
        icon: "database",
        match: "/database/",
      },
      { href: "/storage", label: "Storage", icon: "storage" },
      // Wave 5: Studio slots Edge Functions and Realtime right after Storage.
      { href: "/functions", label: "Edge Functions", icon: "edgeFunctions" },
      { href: "/realtime", label: "Realtime", icon: "realtime" },
      { href: "/api-reference", label: "API Docs", icon: "api" },
    ],
  },
  {
    // Studio's "Integrations" — postgres extensions surfaced as their own
    // operational screens (pg_cron, pgmq, supabase_vault).
    label: "Integrations",
    items: [
      { href: "/integrations/cron", label: "Cron", icon: "cron" },
      { href: "/integrations/queues", label: "Queues", icon: "queues" },
      { href: "/integrations/vault", label: "Vault", icon: "vault" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { href: "/templates", label: "Templates", icon: "templates", marketing: true },
      { href: "/campaigns", label: "SMS Campaigns", icon: "campaigns", marketing: true },
      { href: "/inbox", label: "Inbox", icon: "inbox", marketing: true },
      { href: "/review", label: "Review queue", icon: "review", marketing: true },
      { href: "/suppressions", label: "Suppressions", icon: "suppressions", marketing: true },
      // Wave 6 observability, marketing-tier per the Wave D role model (the
      // route enforces `marketing`, so it lives with the marketing items).
      { href: "/reports", label: "Reports", icon: "reports", marketing: true },
      // Wave 8: competitor-intel RAG module — default prefix matching keeps it
      // lit across /intel/search, /intel/sources/*, /intel/documents/*.
      { href: "/intel", label: "Competitor Intel", icon: "intel", section: "intel" },
    ],
  },
  {
    // The admin pages listed directly — /admin has no landing page (it 308s
    // to /overview), so each item owns its own /admin/* subtree via plain
    // prefix matching; no `match`/`exact` rules needed.
    label: "Admin",
    items: [
      { href: "/admin/auth", label: "Authentication", icon: "auth" },
      { href: "/admin/users", label: "Users", icon: "auth" },
      { href: "/admin/advisors", label: "Advisors", icon: "advisors" },
      { href: "/admin/cloud", label: "Cloud", icon: "cloud" },
      // Logs (explorer + drains subtree) and Infrastructure are ops surfaces —
      // they live under Admin even though their URLs predate the group.
      { href: "/logs", label: "Logs", icon: "logs" },
      { href: "/infrastructure", label: "Infrastructure", icon: "infra" },
    ],
  },
  {
    label: "Project",
    items: [
      { href: "/settings", label: "Settings", icon: "settings", marketing: true },
    ],
  },
];

/** Nav-group label → owning section id, from the SECTIONS registry. */
const GROUP_SECTION = new Map<string, SectionId>(
  SECTIONS.flatMap((s) => s.navGroups.map((label) => [label, s.id] as const)),
);

/**
 * Nav groups visible to a user: non-admins lose the Admin group; when
 * `sections` is passed, every group/item owned by a section they lack
 * (Platform + Integrations → `platform`; the Competitor Intel item → `intel`);
 * when `marketing` is explicitly false, every base-tier item too (Overview,
 * the marketing product items, Settings — all requireMarketingUser routes).
 * Omitting `sections`/`marketing` keeps the pre-tier behavior for that filter.
 * Display filtering ONLY — the routes are the enforcement (`requireAdminUser`,
 * `requireSection*`, `requireMarketingUser`); admins see everything (god-mode
 * implies every section; an admin without `marketing` is not a real persona).
 */
export function navGroupsFor(
  admin: boolean,
  sections?: readonly SectionId[],
  marketing?: boolean,
): NavGroup[] {
  if (admin) return NAV_GROUPS;
  const groups = NAV_GROUPS.filter((g) => g.label !== "Admin");
  if (sections === undefined && marketing === undefined) return groups;
  const has = (id: SectionId) => sections === undefined || sections.includes(id);
  const base = marketing !== false;
  return groups
    .filter((g) => {
      const section = g.label ? GROUP_SECTION.get(g.label) : undefined;
      return section === undefined || has(section);
    })
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          (i.section === undefined || has(i.section)) &&
          (i.marketing === undefined || base),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * Whether a nav item is active for the current path. `exact` items match only
 * their exact route (so Table Editor `/database` never lights on the Database
 * section pages nested beneath it); `match` gives the Database section its
 * own `/database/` subtree scope even though it lands on `/database/schema`.
 * Everything else matches its href or any descendant of it (so SMS Campaigns
 * stays lit across `/campaigns/*`).
 */
function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  if (item.match) {
    return pathname === item.href || pathname.startsWith(item.match);
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Minimal monoline icons (16×16, stroke = currentColor). */
const ICONS: Record<IconKey, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  tableEditor: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M3 14.5h18M9 4v16" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  sql: (
    <>
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
    </>
  ),
  storage: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  templates: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h5" />
    </>
  ),
  campaigns: (
    <>
      <path d="M21 11.5a8 8 0 0 1-8.5 8L7 21l1.2-3.6A8 8 0 1 1 21 11.5z" />
      <path d="M8.5 10h7M8.5 13.5h4.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  review: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  suppressions: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  intel: (
    // Radar sweep — outer ring, inner arc open toward the sweep line.
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5" />
      <path d="M12 12l6-6" />
    </>
  ),
  edgeFunctions: (
    <>
      <path d="M13 2 5 13.5h5.5L11 22l8-11.5h-5.5z" />
    </>
  ),
  realtime: (
    <>
      <circle cx="12" cy="12" r="1.8" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  api: (
    <>
      <path d="M8 6l-5 6 5 6" />
      <path d="M16 6l5 6-5 6" />
    </>
  ),
  advisors: (
    <>
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.2V16h6v-.3c0-.8.4-1.6 1-2.2A6 6 0 0 0 12 3z" />
    </>
  ),
  reports: (
    <>
      <path d="M4 4v15a1 1 0 0 0 1 1h15" />
      <path d="M8 15l4-5 3 3 5-7" />
    </>
  ),
  logs: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M7 9h10M7 12.5h7M7 16h4" />
    </>
  ),
  cron: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  queues: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <rect x="3" y="10" width="18" height="4" rx="1" />
      <rect x="3" y="16" width="18" height="4" rx="1" />
    </>
  ),
  vault: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="1.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14v2.5" />
    </>
  ),
  infra: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  auth: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </>
  ),
  cloud: (
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
};

function NavIcon({ icon }: { icon: IconKey }) {
  return (
    <svg
      className="nav-ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[icon]}
    </svg>
  );
}

/**
 * Left navigation rail. Built from the .surface primitive so it honors the
 * surface tokens. Highlights the active section from the pathname. `admin`
 * defaults false (fail-closed display: no Admin group unless threaded in);
 * `sections`/`marketing` filter the tiered groups/items (see navGroupsFor);
 * an explicit `groups` prop overrides the filter entirely.
 */
export function Nav({
  groups,
  admin = false,
  sections,
  marketing,
}: {
  groups?: NavGroup[];
  admin?: boolean;
  sections?: readonly SectionId[];
  marketing?: boolean;
}) {
  // usePathname() is null outside the App Router context (e.g. in unit tests);
  // fall back to "" so isActive() never calls .startsWith on null.
  const pathname = usePathname() ?? "";
  const visible = groups ?? navGroupsFor(admin, sections, marketing);
  return (
    <Surface as="nav" aria-label="Primary" className="nav" glint>
      {visible.map((group, gi) => (
        <div className="nav-group" key={group.label ?? `group-${gi}`}>
          {group.label ? (
            <span className="nav-group-label">{group.label}</span>
          ) : null}
          <ul className="nav-list">
            {group.items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    className={active ? "nav-link on" : "nav-link"}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                  >
                    <NavIcon icon={item.icon} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Surface>
  );
}

export default Nav;
