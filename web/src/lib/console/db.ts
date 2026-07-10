import "server-only";

import { getServiceClient } from "../supabase";
import type { Template } from "../templates/schema";

const SCHEMA = "marketinghub";
const TABLE = "templates";

export const DEFAULT_PAGE_SIZE = 25;

export interface RowPage {
  rows: Template[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Paginated read of marketinghub.templates rows for the Database table view.
 * Returns an exact total (for pagination) alongside the page slice. Read-only:
 * writes go through the Templates upload flow / the gated API. Fail-loud.
 */
export async function listTemplateRows(
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<RowPage> {
  const requested = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

  // Count first (head-only) so the requested page can be clamped to the real
  // page count BEFORE ranging. Without this, an out-of-range ?page produces a
  // huge offset that PostgREST rejects with 416 (→ thrown error) and a
  // nonsensical "page N of M".
  const { count, error: countError } = await getServiceClient()
    .schema(SCHEMA)
    .from(TABLE)
    .select("*", { count: "exact", head: true });
  if (countError) {
    throw new Error(`[console:db] count failed: ${countError.message}`);
  }

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(requested, pageCount);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error } = await getServiceClient()
    .schema(SCHEMA)
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw new Error(`[console:db] row page failed: ${error.message}`);

  return {
    rows: (data ?? []) as Template[],
    total,
    page: safePage,
    pageSize,
    pageCount,
  };
}
