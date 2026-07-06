import type { ReactNode } from "react";
import { Nav } from "./Nav";
import { ThemeSkinToggle } from "./ThemeSkinToggle";

/**
 * The application shell: a masthead with the NSight wordmark and the global
 * theme/skin toggle, a left nav rail, and the main content region. No banned
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
        <span className="word">
          NSight <em>MarketingHub</em>
        </span>
        <div className="masthead-right">
          <ThemeSkinToggle />
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
