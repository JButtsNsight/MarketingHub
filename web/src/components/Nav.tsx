"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  | "auth"
  | "api"
  | "infra"
  | "admin"
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
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Console information architecture. The platform group mirrors Supabase
 * Studio's nav — same item names, same order (Table Editor, SQL Editor,
 * Database, Authentication, Storage, API Docs) — so it reads 1:1 to anyone
 * who knows Studio. The marketing product and project/ops items follow in
 * their own groups (Studio has no equivalent).
 */
export const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: "/overview", label: "Overview", icon: "overview" }] },
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
      { href: "/auth", label: "Authentication", icon: "auth" },
      { href: "/storage", label: "Storage", icon: "storage" },
      { href: "/api-reference", label: "API Docs", icon: "api" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { href: "/templates", label: "Templates", icon: "templates" },
      { href: "/campaigns", label: "SMS Campaigns", icon: "campaigns" },
      { href: "/inbox", label: "Inbox", icon: "inbox" },
      { href: "/review", label: "Review queue", icon: "review" },
      { href: "/suppressions", label: "Suppressions", icon: "suppressions" },
    ],
  },
  {
    label: "Project",
    items: [
      { href: "/infrastructure", label: "Infrastructure", icon: "infra" },
      { href: "/admin", label: "Admin", icon: "admin" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

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
  auth: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  api: (
    <>
      <path d="M8 6l-5 6 5 6" />
      <path d="M16 6l5 6-5 6" />
    </>
  ),
  infra: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  admin: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="7" cy="18" r="2" />
    </>
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
 * surface tokens. Highlights the active section from the pathname.
 */
export function Nav({ groups = NAV_GROUPS }: { groups?: NavGroup[] }) {
  // usePathname() is null outside the App Router context (e.g. in unit tests);
  // fall back to "" so isActive() never calls .startsWith on null.
  const pathname = usePathname() ?? "";
  return (
    <Surface as="nav" aria-label="Primary" className="nav" glint>
      {groups.map((group, gi) => (
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
