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
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, count, error } = await getServiceClient()
    .schema(SCHEMA)
    .from(TABLE)
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);
  if (error) throw new Error(`[console:db] row page failed: ${error.message}`);

  const total = count ?? 0;
  return {
    rows: (data ?? []) as Template[],
    total,
    page: safePage,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
