import type { TabItem } from "@/components/ui/Tabs";

/**
 * Sub-navigation for the Email section, mirroring the DB_TABS idiom
 * (lib/console/tabs.ts). Surfaces are named exactly as EmailBison names them
 * — "Master Inbox" is their term for the shared reply inbox — so the
 * marketing team's EmailBison knowledge transfers directly.
 */
export const EMAIL_TABS: TabItem[] = [
  { href: "/email", label: "Campaigns" },
  { href: "/email/replies", label: "Master Inbox" },
  { href: "/email/templates", label: "Templates" },
];
