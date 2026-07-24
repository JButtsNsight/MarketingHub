"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Surface } from "./Surface";

export type IconKey =
  | "overview"
  | "database"
  | "storage"
  | "templates"
  | "campaigns"
  | "auth"
  | "api"
  | "infra"
  | "settings";

export interface NavItem {
  href: string;
  label: string;
  icon: IconKey;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Console information architecture, grouped like a Supabase/Appwrite console. */
export const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: "/overview", label: "Overview", icon: "overview" }] },
  {
    label: "Build",
    items: [
      { href: "/database", label: "Database", icon: "database" },
      { href: "/storage", label: "Storage", icon: "storage" },
      { href: "/templates", label: "Templates", icon: "templates" },
      { href: "/campaigns", label: "SMS Campaigns", icon: "campaigns" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/auth", label: "Authentication", icon: "auth" },
      { href: "/api-reference", label: "API", icon: "api" },
      { href: "/infrastructure", label: "Infrastructure", icon: "infra" },
    ],
  },
  {
    label: "Project",
    items: [{ href: "/settings", label: "Settings", icon: "settings" }],
  },
];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
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
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
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
 * global glass/flat skin. Highlights the active section from the pathname.
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
              const active = isActive(pathname, item.href);
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
