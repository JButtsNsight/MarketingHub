import Link from "next/link";
import { Surface } from "./Surface";

export type NavItem = { href: string; label: string };

export const NAV_ITEMS: NavItem[] = [
  { href: "/templates", label: "Templates" },
  { href: "/templates/new", label: "Upload" },
];

/**
 * Left navigation rail. Built from the .surface primitive so it honors the
 * global glass/flat skin.
 */
export function Nav({ items = NAV_ITEMS }: { items?: NavItem[] }) {
  return (
    <Surface as="nav" aria-label="Primary" className="nav" glint>
      <ul className="nav-list">
        {items.map((item) => (
          <li key={item.href}>
            <Link className="nav-link" href={item.href}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

export default Nav;
