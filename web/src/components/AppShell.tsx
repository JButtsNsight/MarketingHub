import type { ReactNode } from "react";
import Link from "next/link";
import type { SectionId } from "@/lib/authGroups";
import { Nav } from "./Nav";
import { ThemeToggle } from "./ThemeToggle";
import { GuidedToggle } from "./GuidedToggle";
import { Guide } from "./guide/Guide";

/**
 * The console shell: a masthead with the MARKETING HUB wordmark (links home) and the
 * global theme toggle; a left nav rail; and the main content region. `admin`
 * (default false) shows the Admin nav group; `sections`/`marketing` filter the
 * tiered nav groups/items — display only; routes enforce.
 * No banned "Claude look" patterns — no centered floating three-card hero,
 * no violet gradients, no frosted glass.
 */
export function AppShell({
  children,
  user,
  admin = false,
  sections,
  marketing,
}: {
  children: ReactNode;
  user?: ReactNode;
  admin?: boolean;
  sections?: readonly SectionId[];
  marketing?: boolean;
}) {
  return (
    <div className="app-shell">
      <header className="masthead">
        <Guide id="nav.shell.wordmark">
          <Link href="/overview" className="word word-link">
            Marketing Hub
          </Link>
        </Guide>
        <div className="masthead-right">
          <Guide id="nav.shell.guided-toggle">
            <GuidedToggle />
          </Guide>
          <Guide id="nav.shell.theme-toggle">
            <ThemeToggle />
          </Guide>
          {user}
        </div>
      </header>
      <div className="app-body">
        <Nav admin={admin} sections={sections} marketing={marketing} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}

export default AppShell;
