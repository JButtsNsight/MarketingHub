"use client";

import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TEMPLATE_CATEGORIES, TEMPLATE_TYPES } from "@/lib/templates/schema";
import { categoryColorVar } from "./categoryColor";

/**
 * Category + type filter chips. Each chip toggles its query param (clicking the
 * active one clears it), preserving the search `q`. Category chips are colored
 * from the data pool by position (never red). Server `templates/page.tsx`
 * re-queries the repo from the resulting params.
 */
export function FilterChips() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeCategory = searchParams.get("category");
  const activeType = searchParams.get("type");

  const toggle = (key: "category" | "type", value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get(key) === value) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="filter-chips">
      <div className="filter-group" role="group" aria-label="Filter by category">
        {TEMPLATE_CATEGORIES.map((c) => {
          const active = activeCategory === c;
          return (
            <button
              key={c}
              type="button"
              className={active ? "chip filter-chip on" : "chip filter-chip"}
              aria-pressed={active}
              style={{ "--chip": categoryColorVar(c) } as CSSProperties}
              onClick={() => toggle("category", c)}
            >
              {c}
            </button>
          );
        })}
      </div>
      <div className="filter-group" role="group" aria-label="Filter by type">
        {TEMPLATE_TYPES.map((t) => {
          const active = activeType === t;
          return (
            <button
              key={t}
              type="button"
              className={active ? "type-chip on" : "type-chip"}
              aria-pressed={active}
              onClick={() => toggle("type", t)}
            >
              {t === "email" ? "Email" : "Text"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default FilterChips;
