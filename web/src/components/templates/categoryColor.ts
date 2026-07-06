import { TEMPLATE_CATEGORIES } from "@/lib/templates/schema";

/**
 * The NSight "data pool" has eight category-coding colors (`--data-1..8`) — and
 * crucially none of them is red (red is reserved for failure only). We assign a
 * category its color BY POSITION in the starter list so the mapping is stable
 * and deterministic; unknown/custom categories fall back to a stable hash.
 */
const POOL_SIZE = 8;

export function categoryColorVar(category: string): string {
  const known = (TEMPLATE_CATEGORIES as readonly string[]).indexOf(category);
  let index: number;
  if (known >= 0) {
    index = known % POOL_SIZE;
  } else {
    let hash = 0;
    for (let i = 0; i < category.length; i++) {
      hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
    }
    index = hash % POOL_SIZE;
  }
  return `var(--data-${index + 1})`;
}
