import type { TabItem } from "@/components/ui/Tabs";

/** Sub-navigation for the Database section. */
export const DB_TABS: TabItem[] = [
  { href: "/database", label: "Rows" },
  { href: "/database/schema", label: "Schema" },
  { href: "/database/rls", label: "RLS" },
];
