"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Guide } from "@/components/guide/Guide";

const DEBOUNCE_MS = 300;

/**
 * Debounced full-text search box. Writes the `q` query param (preserving any
 * active category/type filters) so the server `templates/page.tsx` re-queries
 * the repo. Uses `router.replace` to avoid flooding browser history.
 */
export function SearchBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");
  const isFirst = useRef(true);

  useEffect(() => {
    // Don't navigate on the initial mount (value came from the URL already).
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value, pathname, router, searchParams]);

  return (
    <Guide id="engagement.templates.search">
      <div className="search-bar surface control">
        <input
          type="search"
          aria-label="Search templates"
          placeholder="Search templates…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </Guide>
  );
}

export default SearchBar;
