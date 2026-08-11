import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "../supabase";
import type { RecipientStatus } from "../sms/schema";

/**
 * Data access for the Monday outcome write-back worker. Worker-only: every
 * accessor runs on the service-role client (no `db` param by design — this
 * path stays service_role forever, like the dispatcher accessors in
 * `lib/sms/repo.ts`). This module NEVER touches recipient `status` or any
 * dispatch column — the at-most-once send accounting in sms/repo is out of
 * reach here; only the two watermark columns are written.
 *
 * Candidate query, SQL-side: campaign has a Monday board (CSV campaigns are
 * excluded right here), its list has a configured outcome column, the row
 * has a monday_item_id and an outcome-bearing status. The final idempotency
 * check — synced snapshot vs CURRENT outcome — is app-side by necessity:
 * the outcome is derived from replies/suppressions (deriveOutcome below) and
 * PostgREST cannot compare a column to a computed value. So verified-
 * unchanged rows get their `monday_synced_at` bumped (markVerified) to send
 * them to the back of the nulls-first/oldest-first poll order — that bump is
 * what makes the poll a starvation-free round-robin instead of re-checking
 * the same oldest rows forever. FAILED writes bump it too (markAttemptFailed)
 * — a row whose write can never succeed (deleted item, archived board) must
 * rotate to the back like everything else, or once `batch` such rows exist
 * every tick's candidate slice is exactly those rows and the whole write-back
 * wedges. `monday_synced_at` therefore reads "last instant this row was
 * CHECKED": set with the outcome by a confirmed write (markSynced), alone by
 * a verified no-op or a failed attempt. `monday_synced_status` alone is the
 * confirmed snapshot — a failed row's outcome still differs from it, so the
 * row stays a candidate and retries once per full round-robin cycle.
 */

const SCHEMA = "marketinghub";
const CAMPAIGNS = "sms_campaigns";
const RECIPIENTS = "sms_campaign_recipients";
const LISTS = "contact_lists";
const INBOUND = "sms_inbound_messages";
const SUPPRESSIONS = "sms_suppressions";

/** Max values per PostgREST `.in()` filter (URL-length safety). */
const IN_CHUNK = 200;

/**
 * Outcome-bearing recipient statuses. `sent` is deliberately here despite
 * not being terminal: a late delivery report flips it to (un)delivered, the
 * derived outcome then differs from the synced snapshot, and the write-back
 * converges with exactly one more write. `failed_ambiguous` is deliberately
 * NOT: it is awaiting reconciliation and has no honest outcome yet.
 */
export const WRITEBACK_STATUSES: RecipientStatus[] = [
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "frequency_capped",
  "suppressed",
  "skipped",
  "canceled",
];

function campaigns(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(CAMPAIGNS);
}

function recipients(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(RECIPIENTS);
}

function lists(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(LISTS);
}

function inbound(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(INBOUND);
}

function suppressions(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(SUPPRESSIONS);
}

function fail(op: string, message: string): never {
  throw new Error(`[monday-writeback] ${op} failed: ${message}`);
}

/** Split values into IN_CHUNK-sized slices for `.in()` filters (URL length). */
function inChunks<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    chunks.push(values.slice(i, i + IN_CHUNK));
  }
  return chunks;
}

/** One recipient row due a sync check, with its Monday coordinates joined. */
export interface WritebackCandidate {
  id: string;
  campaignId: string;
  mondayItemId: string;
  phoneE164: string | null;
  status: RecipientStatus;
  /** Row updated_at — the instant it reached its current status. */
  updatedAt: string;
  mondaySyncedAt: string | null;
  /** Outcome string last written to Monday; null = never written. */
  mondaySyncedStatus: string | null;
  boardId: string;
  outcomeColumnId: string;
  /** For the opt-out attribution rule (STOP after this instant counts). */
  campaignSendAt: string;
}

interface CampaignRow {
  id: string;
  contact_list_id: string | null;
  monday_board_id: string | null;
  send_at: string;
}

interface RecipientRow {
  id: string;
  campaign_id: string;
  monday_item_id: string | null;
  phone_e164: string | null;
  status: RecipientStatus;
  updated_at: string;
  monday_synced_at: string | null;
  monday_synced_status: string | null;
}

/** Never-synced first, then oldest confirmation, then oldest status change. */
function bySyncQueueOrder(a: RecipientRow, b: RecipientRow): number {
  if ((a.monday_synced_at === null) !== (b.monday_synced_at === null)) {
    return a.monday_synced_at === null ? -1 : 1;
  }
  if (
    a.monday_synced_at !== null &&
    b.monday_synced_at !== null &&
    a.monday_synced_at !== b.monday_synced_at
  ) {
    return a.monday_synced_at < b.monday_synced_at ? -1 : 1;
  }
  if (a.updated_at !== b.updated_at) {
    return a.updated_at < b.updated_at ? -1 : 1;
  }
  return 0;
}

/**
 * Up to `limit` rows due a sync check, in round-robin order (see the module
 * header). Three bounded queries: board-linked campaigns → their lists'
 * outcome-column config → the rows themselves, joined app-side (PostgREST =
 * no multi-statement transactions; per-row computation stays app-side).
 */
export async function listWritebackCandidates(
  limit: number,
): Promise<WritebackCandidate[]> {
  // CSV campaigns (monday_board_id null) and legacy pre-lists campaigns
  // (contact_list_id null) are excluded here and never re-checked.
  const { data: campaignData, error: campaignError } = await campaigns()
    .select("id, contact_list_id, monday_board_id, send_at")
    .not("monday_board_id", "is", null)
    .not("contact_list_id", "is", null);
  if (campaignError) fail("list-board-campaigns", campaignError.message);
  const campaignRows = (campaignData ?? []) as CampaignRow[];
  if (campaignRows.length === 0) return [];

  // Only lists with a configured outcome column participate.
  const listIds = Array.from(
    new Set(
      campaignRows
        .map((c) => c.contact_list_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const outcomeColumnByList = new Map<string, string>();
  for (const chunk of inChunks(listIds)) {
    const { data, error } = await lists()
      .select("id, monday_outcome_column_id")
      .in("id", chunk)
      .not("monday_outcome_column_id", "is", null);
    if (error) fail("list-outcome-columns", error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      monday_outcome_column_id: string | null;
    }>) {
      if (row.monday_outcome_column_id) {
        outcomeColumnByList.set(row.id, row.monday_outcome_column_id);
      }
    }
  }

  const eligible = new Map<
    string,
    { boardId: string; outcomeColumnId: string; sendAt: string }
  >();
  for (const c of campaignRows) {
    // Belt-and-suspenders re-check of the SQL filters before the join.
    if (!c.monday_board_id || !c.contact_list_id) continue;
    const outcomeColumnId = outcomeColumnByList.get(c.contact_list_id);
    if (!outcomeColumnId) continue;
    eligible.set(c.id, {
      boardId: c.monday_board_id,
      outcomeColumnId,
      sendAt: c.send_at,
    });
  }
  if (eligible.size === 0) return [];

  const rows: RecipientRow[] = [];
  for (const chunk of inChunks(Array.from(eligible.keys()))) {
    const { data, error } = await recipients()
      .select(
        "id, campaign_id, monday_item_id, phone_e164, status, updated_at, monday_synced_at, monday_synced_status",
      )
      .in("campaign_id", chunk)
      .not("monday_item_id", "is", null)
      .in("status", WRITEBACK_STATUSES)
      .order("monday_synced_at", { ascending: true, nullsFirst: true })
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) fail("list-candidates", error.message);
    rows.push(...((data ?? []) as RecipientRow[]));
  }

  // Chunks are each ordered/limited SQL-side; merge + re-slice app-side.
  rows.sort(bySyncQueueOrder);
  const candidates: WritebackCandidate[] = [];
  for (const row of rows.slice(0, limit)) {
    const campaign = eligible.get(row.campaign_id);
    if (!campaign || !row.monday_item_id) continue;
    candidates.push({
      id: row.id,
      campaignId: row.campaign_id,
      mondayItemId: row.monday_item_id,
      phoneE164: row.phone_e164,
      status: row.status,
      updatedAt: row.updated_at,
      mondaySyncedAt: row.monday_synced_at,
      mondaySyncedStatus: row.monday_synced_status,
      boardId: campaign.boardId,
      outcomeColumnId: campaign.outcomeColumnId,
      campaignSendAt: campaign.sendAt,
    });
  }
  return candidates;
}

/**
 * The subset of `recipientIds` that an inbound reply was matched to
 * (`sms_inbound_messages.matched_recipient_id` — exact attribution).
 */
export async function getRepliedRecipientIds(
  recipientIds: string[],
): Promise<Set<string>> {
  const replied = new Set<string>();
  for (const chunk of inChunks(Array.from(new Set(recipientIds)))) {
    const { data, error } = await inbound()
      .select("matched_recipient_id")
      .in("matched_recipient_id", chunk);
    if (error) fail("replied-recipients", error.message);
    for (const row of (data ?? []) as Array<{
      matched_recipient_id: string | null;
    }>) {
      if (row.matched_recipient_id) replied.add(row.matched_recipient_id);
    }
  }
  return replied;
}

/** STOP-list `created_at` per phone, for the opt-out attribution rule. */
export async function getSuppressionCreatedAt(
  phones: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = Array.from(
    new Set(phones.filter((p): p is string => Boolean(p))),
  );
  const map = new Map<string, string>();
  for (const chunk of inChunks(unique)) {
    const { data, error } = await suppressions()
      .select("phone_e164, created_at")
      .in("phone_e164", chunk);
    if (error) fail("suppression-lookup", error.message);
    for (const row of (data ?? []) as Array<{
      phone_e164: string;
      created_at: string;
    }>) {
      map.set(row.phone_e164, row.created_at);
    }
  }
  return map;
}

/** Statuses where a message actually left our system for this campaign. */
const MESSAGED_STATUSES: readonly RecipientStatus[] = [
  "sent",
  "delivered",
  "undelivered",
];

export interface OutcomeInputs {
  status: RecipientStatus;
  /**
   * Row updated_at. Stable date source ONLY because the sync bookkeeping
   * below never bumps it — for terminal rows it is "when it reached this
   * status".
   */
  updatedAt: string;
  campaignSendAt: string;
  /** An inbound reply was matched to THIS row. */
  replied: boolean;
  /** STOP-list created_at for the row's phone, or null. */
  suppressedAt: string | null;
}

/** UTC date of a PostgREST timestamptz (rendered in UTC). */
function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The short outcome string written to the Monday column. ONE convention:
 *
 *   "opted out" | "replied"
 *   | "sent YYYY-MM-DD" | "delivered YYYY-MM-DD" | "undelivered YYYY-MM-DD"
 *   | "failed" | "frequency capped" | "suppressed" | "skipped" | "canceled"
 *
 * Dates are the UTC date the row reached its current status. Deterministic:
 * the same row state always derives the same string, so the consumer's
 * snapshot comparison (`outcome !== monday_synced_status`) is the whole
 * idempotency contract.
 *
 * Enrichment precedence: "opted out" beats "replied" beats the status ("STOP"
 * is itself a reply — the compliance state must win). Opt-out attribution is
 * the sms_campaign_engagement view's rule verbatim: the phone was actually
 * messaged by this campaign AND joined the STOP list at/after the campaign's
 * send_at. That honestly OVER-attributes exactly as the view documents — a
 * phone messaged by two campaigns before texting STOP marks BOTH campaigns'
 * rows "opted out", because we cannot know which message prompted it and
 * losing the signal is worse. ("suppressed" is the distinct pre-send state:
 * the phone was already on the STOP list, so nothing was ever sent.) Replies
 * only enrich messaged rows: a `failed` row with a matched reply stays
 * "failed" — a human explicitly settled it (markRecipientFailed) and that
 * call outranks the inference.
 */
export function deriveOutcome(inputs: OutcomeInputs): string {
  const messaged = MESSAGED_STATUSES.includes(inputs.status);
  if (
    messaged &&
    inputs.suppressedAt !== null &&
    Date.parse(inputs.suppressedAt) >= Date.parse(inputs.campaignSendAt)
  ) {
    return "opted out";
  }
  if (messaged && inputs.replied) return "replied";

  switch (inputs.status) {
    case "sent":
      return `sent ${dateOf(inputs.updatedAt)}`;
    case "delivered":
      return `delivered ${dateOf(inputs.updatedAt)}`;
    case "undelivered":
      return `undelivered ${dateOf(inputs.updatedAt)}`;
    case "failed":
      return "failed";
    case "frequency_capped":
      return "frequency capped";
    case "suppressed":
      return "suppressed";
    case "skipped":
      return "skipped";
    case "canceled":
      return "canceled";
    default:
      // Unreachable via listWritebackCandidates (status filter); still
      // deterministic for defense in depth.
      return inputs.status;
  }
}

/**
 * Record a CONFIRMED Monday write: the watermark stores exactly what was
 * written, even if the row's status moved on mid-write — the next tick's
 * snapshot comparison then schedules the newer outcome. Two deliberate
 * deviations from sms/repo habits, both load-bearing:
 *
 * - NO status guard: this update never touches status or any dispatch
 *   column, so the at-most-once send accounting is not in play, and a guard
 *   would make the watermark lie about what Monday now shows.
 * - NO updated_at stamp: (1) reply/delivery-report attribution picks "the
 *   newest row for a phone" BY updated_at (findRecipientForInbound /
 *   findRecipientForDeliveryReport) — a bookkeeping bump would let an old
 *   campaign's row steal a fresh reply from a newer campaign's; (2) the
 *   dated outcome strings derive from updated_at, and bumping it would shift
 *   the date and trigger a spurious re-write per row.
 */
export async function markSynced(
  id: string,
  outcome: string,
  syncedAt: Date,
): Promise<void> {
  const { error } = await recipients()
    .update({
      monday_synced_at: syncedAt.toISOString(),
      monday_synced_status: outcome,
    })
    .eq("id", id);
  if (error) fail("mark-synced", error.message);
}

/**
 * Record a verified no-op for already-in-sync rows: bump monday_synced_at
 * ONLY (the snapshot still names the value Monday holds; updated_at stays
 * untouched — see markSynced). This bump is the round-robin's liveness: a
 * checked row goes to the back of the oldest-first queue, so late replies /
 * opt-outs / delivery reports on ANY row are re-derived within one full
 * cycle instead of starving behind stable rows.
 */
export async function markVerified(
  ids: string[],
  verifiedAt: Date,
): Promise<void> {
  for (const chunk of inChunks(ids)) {
    const { error } = await recipients()
      .update({ monday_synced_at: verifiedAt.toISOString() })
      .in("id", chunk);
    if (error) fail("mark-verified", error.message);
  }
}

/**
 * Record a FAILED write attempt: bump monday_synced_at ONLY, exactly like
 * markVerified — the row rotates to the back of the round-robin instead of
 * pinning the queue head forever (the liveness failure mode: >= batch
 * permanently-failing rows would otherwise BE every tick's candidate list,
 * starving every other campaign). monday_synced_status is deliberately NOT
 * touched: it still names what Monday last confirmed, so the outcome
 * comparison keeps the row a candidate and it retries once per full cycle.
 */
export async function markAttemptFailed(
  id: string,
  attemptedAt: Date,
): Promise<void> {
  const { error } = await recipients()
    .update({ monday_synced_at: attemptedAt.toISOString() })
    .eq("id", id);
  if (error) fail("mark-attempt-failed", error.message);
}
