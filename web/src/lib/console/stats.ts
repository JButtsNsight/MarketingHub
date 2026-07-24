import "server-only";

import { getServiceClient } from "../supabase";

const SCHEMA = "marketinghub";
const TABLE = "templates";

export interface Count {
  label: string;
  count: number;
}

export interface TemplateStats {
  total: number;
  byType: Count[];
  byCategory: Count[];
  /** created_at of the most recent template, or null when empty. */
  latest: string | null;
}

/**
 * Live template statistics for the Overview dashboard. Reads an exact row count
 * plus the minimal columns needed to derive type/category breakdowns. Fail-loud
 * on any Supabase error (never a fabricated zero).
 */
export async function getTemplateStats(): Promise<TemplateStats> {
  const { data, count, error } = await getServiceClient()
    .schema(SCHEMA)
    .from(TABLE)
    .select("type,category,created_at", { count: "exact" })
    .order("created_at", { ascending: false });
  if (error) throw new Error(`[console:stats] query failed: ${error.message}`);

  const rows = (data ?? []) as {
    type: string;
    category: string;
    created_at: string;
  }[];

  const typeCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
  }

  return {
    total: count ?? rows.length,
    byType: [...typeCounts].map(([label, c]) => ({ label, count: c })),
    byCategory: [...categoryCounts]
      .map(([label, c]) => ({ label, count: c }))
      .sort((a, b) => b.count - a.count),
    latest: rows[0]?.created_at ?? null,
  };
}
