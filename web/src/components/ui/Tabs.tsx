"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface TabItem {
  href: string;
  label: string;
}

/**
 * Section sub-navigation as link tabs. The active tab is derived from the
 * current pathname (exact match, or a nested route under it), so tabs work as
 * plain server-rendered links with client-side active styling only.
 */
export function Tabs({ items }: { items: TabItem[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav className="tabs" aria-label="Section">
      {items.map((it) => {
        const active = pathname === it.href;
        return (
          <Link
            key={it.href}
            href={it.href}
            className={active ? "tab on" : "tab"}
            aria-current={active ? "page" : undefined}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default Tabs;
