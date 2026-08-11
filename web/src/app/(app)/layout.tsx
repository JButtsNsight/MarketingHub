import type { ReactNode } from "react";
import { headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { UserMenu } from "@/components/UserMenu";
import { getUser } from "@/lib/auth";
import { isAdmin } from "@/lib/authGroups";

/**
 * Layout for the authenticated console. Everything in this route group renders
 * inside the AppShell (masthead + nav). The (auth) login route lives OUTSIDE
 * this group, so it renders bare — no shell controls sit focusable behind the
 * sign-in screen. Identity comes from the ALB Cognito header, resolved
 * server-side; it only decides whether to show the UserMenu and the Admin nav
 * group (display filter — per-page/route gates do the actual authorization).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getUser(await headers());

  return (
    <AppShell
      admin={user !== null && isAdmin(user)}
      user={user ? <UserMenu email={user.email} /> : undefined}
    >
      {children}
    </AppShell>
  );
}
