import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { UserMenu } from "@/components/UserMenu";
import { getUser } from "@/lib/auth";
import {
  isAdmin,
  MARKETING_GROUP,
  SECTIONS,
  sectionAllows,
} from "@/lib/authGroups";

/**
 * Layout for the authenticated console. Everything in this route group renders
 * inside the AppShell (masthead + nav). The (auth) login route lives OUTSIDE
 * this group, so it renders bare — no shell controls sit focusable behind the
 * sign-in screen. Identity comes from the ALB Cognito header, resolved
 * server-side; it only decides whether to show the UserMenu and which nav
 * groups render — the Admin group per `isAdmin`, the sectioned groups/items
 * per the SECTIONS registry, the base-tier items per the `marketing` group
 * (display filter — per-page/route gates do the actual authorization; admins
 * pass every section).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getUser(await headers());
  const sections = user
    ? SECTIONS.filter((s) => sectionAllows(user, s.id)).map((s) => s.id)
    : [];

  return (
    <AppShell
      admin={user !== null && isAdmin(user)}
      sections={sections}
      marketing={user !== null && user.groups.includes(MARKETING_GROUP)}
      user={user ? <UserMenu email={user.email} /> : undefined}
    >
      {children}
    </AppShell>
  );
}
