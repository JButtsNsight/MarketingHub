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
  { href: "/database/webhooks", label: "Webhooks" },
  { href: "/database/designer", label: "Designer" },
];
