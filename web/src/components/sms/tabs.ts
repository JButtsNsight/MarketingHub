import type { TabItem } from "@/components/ui/Tabs";

/**
 * Sub-navigation for the SMS section, mirroring EMAIL_TABS (the two campaign
 * types read the same way). These surfaces were flat Marketing nav items
 * until 2026-08-14; their routes are unchanged, so old bookmarks still land —
 * the tabs are the navigation, the rail shows one "SMS Campaigns" item.
 */
export const SMS_TABS: TabItem[] = [
  { href: "/campaigns", label: "Campaigns" },
  { href: "/campaigns/schedule", label: "Schedule" },
  { href: "/campaigns/templates", label: "Templates" },
  { href: "/inbox", label: "Inbox" },
  { href: "/review", label: "Review queue" },
  { href: "/suppressions", label: "Suppressions" },
];
