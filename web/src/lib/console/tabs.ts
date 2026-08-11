import type { TabItem } from "@/components/ui/Tabs";

/**
 * Sub-navigation for the Database SECTION (Studio parity). The Table Editor
 * grid is its own top-level nav item (/database) with no tab strip — matching
 * Studio, where Table Editor and Database are separate destinations. These
 * tabs cover the Database section's pages only.
 */
export const DB_TABS: TabItem[] = [
  { href: "/database/schema", label: "Schema" },
  { href: "/database/rls", label: "Policies" },
  { href: "/database/functions", label: "Functions" },
  { href: "/database/triggers", label: "Triggers" },
  { href: "/database/indexes", label: "Indexes" },
  { href: "/database/types", label: "Types" },
  { href: "/database/extensions", label: "Extensions" },
  { href: "/database/publications", label: "Publications" },
  { href: "/database/roles", label: "Roles" },
  // Studio's Database→Platform subgroup lists Backups before Webhooks; the
  // custom Designer stays last.
  { href: "/database/backups", label: "Backups" },
  { href: "/database/webhooks", label: "Webhooks" },
  { href: "/database/designer", label: "Designer" },
];

/**
 * Sub-navigation for the Authentication section, folded into the Admin area
 * (IA change: no top-level Platform nav item). `/admin/auth` is the landing
 * page (identity & access reference); Users and Providers are the
 * Wave-3-partial READ-ONLY GoTrue admin views (user store browser + auth
 * configuration — zero mutation affordances by hard wave constraint, Wave-3
 * proper blocked on the external SAML deliverable); Impersonation is the
 * Wave-4 "what can this identity see" console.
 */
export const AUTH_TABS: TabItem[] = [
  { href: "/admin/auth", label: "Overview" },
  { href: "/admin/auth/users", label: "Users" },
  { href: "/admin/auth/providers", label: "Providers" },
  { href: "/admin/auth/impersonate", label: "Impersonation" },
];

/**
 * Sub-navigation for the Logs section (Wave 6, Studio parity): the explorer
 * over the seven shipped Logflare sources, plus the honest static Drains
 * capability panel. Reports is its own top-level nav item, not a tab here.
 */
export const LOGS_TABS: TabItem[] = [
  { href: "/logs", label: "Explorer" },
  { href: "/logs/drains", label: "Drains" },
];
