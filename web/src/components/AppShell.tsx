import type { ReactNode } from "react";
import Link from "next/link";
import { Nav } from "./Nav";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The console shell: a masthead with the Nsight wordmark (links home) and the
 * global theme toggle; a left nav rail; and the main content region. No banned
 * "Claude look" patterns — no centered floating three-card hero, no violet
 * gradients, no frosted glass.
 */
export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user?: ReactNode;
}) {
  return (
    <div className="app-shell">
      <header className="masthead">
        <Link href="/overview" className="word word-link">
          Nsight <em>MarketingHub</em>
        </Link>
        <div className="masthead-right">
          <ThemeToggle />
          {user}
        </div>
      </header>
      <div className="app-body">
        <Nav />
        <main className="app-main">{children}</main>
      </div>
    </div>
  );
}

export default AppShell;
