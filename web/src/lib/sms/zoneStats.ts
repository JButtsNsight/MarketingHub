import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "../supabase";
import { SEND_TIMEZONES, zoneAbbr } from "./schedule";

/**
 * Display-only send-zone aggregates behind the campaign pages' "N zones"
 * chip. Kept out of repo.ts on purpose: nothing here touches outbox state or
 * its conditional-update guards.
 */

const SCHEMA = "marketinghub";
/** campaign_id × send_timezone × count view (security_invoker). */
const ZONE_COUNTS_VIEW = "sms_campaign_recipient_zone_counts";

/** Max values per PostgREST `.in()` filter (URL-length safety, as repo.ts). */
const IN_CHUNK = 200;
/** View rows per page (≤ 5 explicit zones per campaign — 1 page in practice). */
const PAGE = 1000;

/** zone id → outbox rows sending in that zone. */
export type ZoneCounts = Map<string, number>;

function zoneCountsView(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(ZONE_COUNTS_VIEW);
}

function fail(op: string, message: string): never {
  throw new Error(`[sms] ${op} failed: ${message}`);
}

/**
 * Rows with an EXPLICIT send_timezone, counted per campaign × zone via the
 * sms_campaign_recipient_zone_counts view — the aggregation is SQL-side, so
 * the transfer is one row per campaign × zone (≤ 5 each), never one per
 * recipient. Null-zone rows (the campaign-zone fallback, incl. every
 * pre-timezone row) are deliberately not fetched — foldZoneCounts derives
 * their bucket from the row total the caller already holds.
 */
export async function getExplicitZoneCounts(
  campaignIds: string[],
  db?: SupabaseClient,
): Promise<Map<string, ZoneCounts>> {
  const byCampaign = new Map<string, ZoneCounts>();
  const unique = Array.from(new Set(campaignIds));

  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    // Still paged defensively (PostgREST row caps), though a full page means
    // 200+ multi-zone campaigns in one chunk.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await zoneCountsView(db)
        .select("campaign_id, send_timezone, count")
        .in("campaign_id", chunk)
        .not("send_timezone", "is", null)
        .order("campaign_id", { ascending: true }) // stable page boundaries
        .order("send_timezone", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) fail("zone-counts", error.message);
      const rows = (data ?? []) as Array<{
        campaign_id: string;
        send_timezone: string;
        count: number;
      }>;
      for (const row of rows) {
        const counts = byCampaign.get(row.campaign_id) ?? new Map();
        counts.set(row.send_timezone, row.count);
        byCampaign.set(row.campaign_id, counts);
      }
      if (rows.length < PAGE) break;
    }
  }
  return byCampaign;
}

/**
 * A campaign's full zone spread: the explicit per-zone counts plus the
 * fallback bucket (`totalRows` − explicit rows, i.e. every null-zone row)
 * folded into the campaign's own zone.
 */
export function foldZoneCounts(
  explicit: ZoneCounts | undefined,
  campaignZone: string,
  totalRows: number,
): ZoneCounts {
  const counts: ZoneCounts = new Map(explicit ?? []);
  let explicitTotal = 0;
  for (const n of counts.values()) explicitTotal += n;
  const fallback = totalRows - explicitTotal;
  if (fallback > 0) {
    counts.set(campaignZone, (counts.get(campaignZone) ?? 0) + fallback);
  }
  return counts;
}

/** SEND_TIMEZONES position (east → west); unknown zones sort last. */
function zoneOrder(zone: string): number {
  const i = SEND_TIMEZONES.findIndex((z) => z.id === zone);
  return i === -1 ? SEND_TIMEZONES.length : i;
}

/**
 * The "N zones" chip for a multi-zone audience — null when every row sits in
 * one zone. `title` lists zones + row counts, east to west.
 */
export function zoneChip(
  counts: ZoneCounts,
): { label: string; title: string } | null {
  if (counts.size < 2) return null;
  const ordered = Array.from(counts.keys()).sort(
    (a, b) => zoneOrder(a) - zoneOrder(b),
  );
  return {
    label: `${counts.size} zones`,
    title: ordered.map((z) => `${zoneAbbr(z)} ${counts.get(z)}`).join(" · "),
  };
}
