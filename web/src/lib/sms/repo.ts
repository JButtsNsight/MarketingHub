import "server-only";

import { getServiceClient } from "../supabase";
import {
  CampaignCreateInputSchema,
  CampaignRescheduleInputSchema,
  RECIPIENT_STATUSES,
  type CampaignCounts,
  type CampaignCreateInput,
  type CampaignEngagement,
  type CampaignRescheduleInput,
  type CampaignStatus,
  type RecipientStatus,
  type SmsCampaign,
  type SmsCampaignRecipient,
  type SmsInboundMessage,
  type SmsSuppression,
} from "./schema";
import type { TrackedLink } from "./links";
import { firstNameOf, renderSms } from "./render";
import { sendAtForZonedSlot } from "./schedule";

/**
 * Data access for SMS campaigns — the durable outbox behind the dispatcher
 * worker and the campaign API routes. Every function talks to the
 * `marketinghub` schema via the service-role PostgREST client and fails loud
 * on unexpected PostgREST errors.
 *
 * Durability rule: every state transition here is a CONDITIONAL update
 * (`.eq('status', expected)` / `.in('status', [...])`). Row count = won/lost;
 * `null` return = lost the race (caller skips or routes 409). Never widen a
 * guard — the at-most-once send accounting depends on them.
 */

const SCHEMA = "marketinghub";
const CAMPAIGNS = "sms_campaigns";
const RECIPIENTS = "sms_campaign_recipients";
const SUPPRESSIONS = "sms_suppressions";
const WEBHOOK_EVENTS = "sms_webhook_events";
const LINKS = "sms_links";
const LINK_CLICKS = "sms_link_clicks";
const INBOUND = "sms_inbound_messages";
const SUPPRESSION_AUDIT = "sms_suppression_audit";
/** campaign_id × status × count view (security_invoker). */
const COUNTS_VIEW = "sms_campaign_recipient_counts";
/** Per-campaign click/reply/opt-out aggregates view (security_invoker). */
const ENGAGEMENT_VIEW = "sms_campaign_engagement";

/** Max values per PostgREST `.in()` filter (URL-length safety). */
const IN_CHUNK = 200;
/** Recipient rows per insert statement at creation time. */
const INSERT_CHUNK = 200;

/** Minimal identity to stamp ownership (Cognito user is compatible). */
export interface CampaignCreator {
  email: string;
}

/**
 * The Monday coordinates snapshotted onto the campaign row when the chosen
 * contact list is a linked board — both null for uploaded sheets. (The list
 * id itself travels in CampaignCreateInput.)
 */
export interface CampaignSource {
  mondayBoardId: string | null;
  mondayPhoneColumnId: string | null;
}

function campaigns() {
  return getServiceClient().schema(SCHEMA).from(CAMPAIGNS);
}

function recipients() {
  return getServiceClient().schema(SCHEMA).from(RECIPIENTS);
}

function suppressions() {
  return getServiceClient().schema(SCHEMA).from(SUPPRESSIONS);
}

function countsView() {
  return getServiceClient().schema(SCHEMA).from(COUNTS_VIEW);
}

function webhookEvents() {
  return getServiceClient().schema(SCHEMA).from(WEBHOOK_EVENTS);
}

function links() {
  return getServiceClient().schema(SCHEMA).from(LINKS);
}

function linkClicks() {
  return getServiceClient().schema(SCHEMA).from(LINK_CLICKS);
}

function inbound() {
  return getServiceClient().schema(SCHEMA).from(INBOUND);
}

function suppressionAudit() {
  return getServiceClient().schema(SCHEMA).from(SUPPRESSION_AUDIT);
}

function engagementView() {
  return getServiceClient().schema(SCHEMA).from(ENGAGEMENT_VIEW);
}

function fail(op: string, message: string): never {
  throw new Error(`[sms] ${op} failed: ${message}`);
}

/** updated_at is app-maintained (no DB trigger) — stamp it on every update. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Split values into IN_CHUNK-sized slices for `.in()` filters (URL length). */
function inChunks<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    chunks.push(values.slice(i, i + IN_CHUNK));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * One recipient as extracted from a source: a Monday board (Phase 4
 * `fetchBoardRecipients` output is structurally compatible) or a CSV
 * contact-list member (`mondayItemId` absent).
 */
export interface SourceRecipientRow {
  mondayItemId?: string | null;
  name: string;
  firstName: string;
  phoneE164: string | null;
  rawPhone: string;
}

/** Back-compat alias — the Monday fetch path predates CSV lists. */
export type MondayRecipientRow = SourceRecipientRow;

/** Creation-time statuses — everything else is owned by the dispatcher. */
export type PreparedRecipientStatus = Extract<
  RecipientStatus,
  "pending" | "suppressed" | "skipped"
>;

/** An outbox row ready to insert (campaign_id/send_after added by create). */
export interface PreparedRecipient {
  monday_item_id: string | null;
  name: string;
  first_name: string;
  phone_e164: string | null;
  rendered_text: string;
  status: PreparedRecipientStatus;
  last_error: string | null;
  /**
   * Tracked short links embedded in rendered_text (slug → target), persisted
   * to sms_links after the row insert returns its id. Absent/empty when link
   * tracking is off (LINK_BASE_URL unset) or the body has no URLs. NOT a
   * column — stripped before insert.
   */
  links?: TrackedLink[];
}

/**
 * Pure creation-time classification of source rows into outbox rows:
 *
 * - unusable phone (`phoneE164` null)  → `skipped`, raw phone in last_error;
 * - duplicate phone (first row wins)   → `skipped` with `phone_e164 = null` —
 *   the DB has `unique (campaign_id, phone_e164)` and nulls are distinct, so
 *   dupes MUST NOT carry the phone or the insert would violate it; the raw
 *   phone is preserved in last_error for audit;
 * - phone on the STOP list             → `suppressed` (phone kept);
 * - otherwise                          → `pending`.
 *
 * `rendered_text` is snapshotted for every row (audit trail), even skipped.
 */
export function prepareRecipients(
  sourceRows: SourceRecipientRow[],
  body: string,
  suppressedSet: ReadonlySet<string>,
): PreparedRecipient[] {
  const seenPhones = new Set<string>();

  return sourceRows.map((row) => {
    const firstName = row.firstName.trim() || firstNameOf(row.name);
    const base = {
      monday_item_id: row.mondayItemId ?? null,
      name: row.name,
      first_name: firstName,
      rendered_text: renderSms(body, { name: row.name, firstName }),
    };

    if (!row.phoneE164) {
      return {
        ...base,
        phone_e164: null,
        status: "skipped" as const,
        last_error: `skipped: no usable US phone (raw: ${row.rawPhone})`,
      };
    }
    if (seenPhones.has(row.phoneE164)) {
      return {
        ...base,
        phone_e164: null,
        status: "skipped" as const,
        last_error: `skipped: duplicate phone, first occurrence kept (raw: ${row.rawPhone})`,
      };
    }
    seenPhones.add(row.phoneE164);

    if (suppressedSet.has(row.phoneE164)) {
      return {
        ...base,
        phone_e164: row.phoneE164,
        status: "suppressed" as const,
        last_error: "suppressed: phone is on the STOP list",
      };
    }
    return {
      ...base,
      phone_e164: row.phoneE164,
      status: "pending" as const,
      last_error: null,
    };
  });
}

/**
 * The subset of `phones` present on the STOP list, queried in chunks of
 * 200 per `.in()` filter (PostgREST filters travel in the URL).
 */
export async function getSuppressedSet(
  phones: Array<string | null>,
): Promise<Set<string>> {
  const unique = Array.from(
    new Set(phones.filter((p): p is string => Boolean(p))),
  );
  const suppressed = new Set<string>();

  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { data, error } = await suppressions()
      .select("phone_e164")
      .in("phone_e164", chunk);
    if (error) fail("suppressed-set", error.message);
    for (const row of (data ?? []) as Array<{ phone_e164: string }>) {
      suppressed.add(row.phone_e164);
    }
  }
  return suppressed;
}

/**
 * Create a campaign plus its outbox rows. The campaign row snapshots the
 * template body (`message_body`) and the computed 11:30 AM America/New_York
 * instant (`send_at`); every recipient starts with `send_after = send_at`.
 *
 * Recipients are inserted in chunks of 200. NOT transactional (PostgREST has
 * no multi-statement transactions), so the campaign is born `paused` — a
 * non-dispatchable state — and only flips paused → `scheduled` as the FINAL
 * step, after the last chunk lands. A crash mid-insert therefore leaves a
 * visible paused campaign, not a live partial one. CAVEAT: `paused` is
 * resumable by hand — an unexplained paused campaign you did not pause is a
 * mid-create crash artifact (partial audience, possibly rendered short
 * links whose sms_links rows never landed) and must be CANCELED and
 * re-created, never resumed. On a chunk failure the campaign is additionally
 * best-effort marked `canceled` and the error is re-thrown; a lost final
 * flip fails loud.
 */
export async function createCampaign(
  input: CampaignCreateInput,
  source: CampaignSource,
  messageBody: string,
  prepared: PreparedRecipient[],
  user: CampaignCreator,
): Promise<SmsCampaign> {
  const parsed = CampaignCreateInputSchema.parse(input);
  const sendAt = sendAtForZonedSlot(
    parsed.sendDate,
    parsed.sendTime,
    parsed.sendTimezone,
  ).toISOString();

  const { data, error } = await campaigns()
    .insert({
      name: parsed.name,
      template_id: parsed.templateId,
      contact_list_id: parsed.contactListId,
      monday_board_id: source.mondayBoardId,
      monday_phone_column_id: source.mondayPhoneColumnId,
      message_body: messageBody,
      send_date: parsed.sendDate,
      send_time: parsed.sendTime,
      send_timezone: parsed.sendTimezone,
      send_at: sendAt,
      status: "paused",
      created_by: user.email,
    })
    .select()
    .single();
  if (error) fail("create", error.message);
  const campaign = data as SmsCampaign;

  // `links` is repo bookkeeping, not a column — strip it before insert and
  // keep a parallel per-row array for the sms_links inserts below.
  const rows = prepared.map(({ links: _links, ...r }) => ({
    ...r,
    campaign_id: campaign.id,
    send_after: sendAt,
  }));
  const rowLinks = prepared.map((r) => r.links ?? []);
  const hasLinks = rowLinks.some((l) => l.length > 0);

  // Best-effort: a partially-populated campaign must never dispatch.
  const cancelAndFail = async (
    op: string,
    at: number,
    message: string,
  ): Promise<never> => {
    try {
      await campaigns()
        .update({ status: "canceled", updated_at: nowIso() })
        .eq("id", campaign.id);
    } catch {
      // the original failure is the one worth surfacing
    }
    fail(op, `chunk at ${at} (campaign ${campaign.id} canceled): ${message}`);
  };

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);

    if (!hasLinks) {
      const { error: insertError } = await recipients().insert(chunk);
      if (insertError) {
        return cancelAndFail("create-recipients", i, insertError.message);
      }
      continue;
    }

    // Link tracking needs the fresh row ids to key sms_links on.
    const { data: inserted, error: insertError } = await recipients()
      .insert(chunk)
      .select("id, rendered_text");
    if (insertError) {
      return cancelAndFail("create-recipients", i, insertError.message);
    }
    const returned = (inserted ?? []) as Array<{
      id: string;
      rendered_text: string;
    }>;
    if (returned.length !== chunk.length) {
      return cancelAndFail(
        "create-links",
        i,
        `insert returned ${returned.length} rows for a chunk of ${chunk.length}`,
      );
    }

    const linkRows: Array<{
      slug: string;
      campaign_id: string;
      recipient_id: string;
      target_url: string;
    }> = [];
    for (let j = 0; j < chunk.length; j += 1) {
      const linksForRow = rowLinks[i + j];
      if (linksForRow.length === 0) continue;
      // PostgREST returns inserted rows in insert order; the rendered_text
      // equality check turns any violation of that assumption into a loud
      // failure instead of silently mis-attributing clicks.
      if (returned[j].rendered_text !== chunk[j].rendered_text) {
        return cancelAndFail(
          "create-links",
          i,
          "returned rows out of order (rendered_text mismatch)",
        );
      }
      for (const link of linksForRow) {
        linkRows.push({
          slug: link.slug,
          campaign_id: campaign.id,
          recipient_id: returned[j].id,
          target_url: link.targetUrl,
        });
      }
    }

    for (let k = 0; k < linkRows.length; k += INSERT_CHUNK) {
      const { error: linkError } = await links().insert(
        linkRows.slice(k, k + INSERT_CHUNK),
      );
      if (linkError) {
        return cancelAndFail("create-links", i, linkError.message);
      }
    }
  }

  // Go live only now that every outbox row exists. Guarded on 'paused' and
  // fail-loud when the flip loses (e.g. someone canceled it mid-create).
  const { data: activated, error: activateError } = await campaigns()
    .update({ status: "scheduled", updated_at: nowIso() })
    .eq("id", campaign.id)
    .eq("status", "paused")
    .select()
    .maybeSingle();
  if (activateError) fail("create-activate", activateError.message);
  if (!activated) {
    fail(
      "create-activate",
      `campaign ${campaign.id} was no longer paused after inserting recipients`,
    );
  }
  return activated as SmsCampaign;
}

/**
 * Idempotency backstop for creation: an existing campaign with the same
 * template + contact list + send date that is still live (`scheduled`/
 * `sending`/`paused`) — a double-submit would text the same audience twice.
 * Terminal campaigns (completed/canceled) never block a deliberate re-create.
 */
export async function findActiveDuplicateCampaign(
  templateId: string,
  contactListId: string,
  sendDate: string,
): Promise<SmsCampaign | null> {
  const { data, error } = await campaigns()
    .select("*")
    .eq("template_id", templateId)
    .eq("contact_list_id", contactListId)
    .eq("send_date", sendDate)
    .in("status", ["scheduled", "sending", "paused"])
    .limit(1);
  if (error) fail("find-duplicate", error.message);
  return ((data ?? []) as SmsCampaign[])[0] ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Per-status recipient totals, zero-filled across every status. */
export type CountsByStatus = Record<RecipientStatus, number>;

export interface CampaignWithCounts extends SmsCampaign {
  counts: CountsByStatus;
}

function zeroCounts(): CountsByStatus {
  const counts = {} as CountsByStatus;
  for (const status of RECIPIENT_STATUSES) counts[status] = 0;
  return counts;
}

function foldCounts(rows: CampaignCounts[]): Map<string, CountsByStatus> {
  const byCampaign = new Map<string, CountsByStatus>();
  for (const row of rows) {
    const counts = byCampaign.get(row.campaign_id) ?? zeroCounts();
    counts[row.status] = row.count;
    byCampaign.set(row.campaign_id, counts);
  }
  return byCampaign;
}

/** All campaigns (newest first) with zero-filled per-status recipient counts. */
export async function listCampaignsWithCounts(): Promise<CampaignWithCounts[]> {
  const { data, error } = await campaigns()
    .select("*")
    .order("created_at", { ascending: false });
  if (error) fail("list", error.message);
  const rows = (data ?? []) as SmsCampaign[];
  if (rows.length === 0) return [];

  // Chunked like getSuppressedSet — PostgREST .in() filters travel in the URL.
  const countRows: CampaignCounts[] = [];
  for (const chunk of inChunks(rows.map((c) => c.id))) {
    const { data: chunkRows, error: countsError } = await countsView()
      .select("*")
      .in("campaign_id", chunk);
    if (countsError) fail("list-counts", countsError.message);
    countRows.push(...((chunkRows ?? []) as CampaignCounts[]));
  }
  const byCampaign = foldCounts(countRows);

  return rows.map((campaign) => ({
    ...campaign,
    counts: byCampaign.get(campaign.id) ?? zeroCounts(),
  }));
}

/** Fetch one campaign, or null if it does not exist. */
export async function getCampaign(id: string): Promise<SmsCampaign | null> {
  const { data, error } = await campaigns()
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) fail("get", error.message);
  return (data as SmsCampaign) ?? null;
}

/** Outbox rows for a campaign in creation order, capped at 2000 for the UI. */
export async function getCampaignRecipients(
  campaignId: string,
): Promise<SmsCampaignRecipient[]> {
  const { data, error } = await recipients()
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) fail("get-recipients", error.message);
  return (data ?? []) as SmsCampaignRecipient[];
}

/** Zero-filled per-status recipient counts for one campaign (via the view). */
export async function getCampaignCounts(
  campaignId: string,
): Promise<CountsByStatus> {
  const { data, error } = await countsView()
    .select("*")
    .eq("campaign_id", campaignId);
  if (error) fail("get-counts", error.message);
  const counts = zeroCounts();
  for (const row of (data ?? []) as CampaignCounts[]) {
    counts[row.status] = row.count;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Conditional transitions (API PATCH actions). Every transition is guarded by
// the expected current status; `null` = the guard lost (caller routes 409).
// ---------------------------------------------------------------------------

/**
 * Pause a `scheduled`/`sending` campaign, releasing its `claimed` (not yet
 * attempted) rows back to `pending`. Rows the dispatcher already claimed in
 * memory are safe: its claimed → sending update is guarded on
 * `.eq('status','claimed')` and will match 0 rows after this release.
 */
export async function pauseCampaign(id: string): Promise<SmsCampaign | null> {
  const { data, error } = await campaigns()
    .update({ status: "paused", updated_at: nowIso() })
    .eq("id", id)
    .in("status", ["scheduled", "sending"])
    .select()
    .maybeSingle();
  if (error) fail("pause", error.message);
  if (!data) return null;

  const { error: releaseError } = await recipients()
    .update({
      status: "pending",
      claimed_at: null,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("campaign_id", id)
    .eq("status", "claimed");
  if (releaseError) fail("pause-release", releaseError.message);

  return data as SmsCampaign;
}

/**
 * Resume a paused campaign to `scheduled` — the dispatcher's promotion query
 * is the single decision point for "actively dispatching", so resume never
 * jumps straight to `sending`.
 */
export async function resumeCampaign(id: string): Promise<SmsCampaign | null> {
  const { data, error } = await campaigns()
    .update({ status: "scheduled", updated_at: nowIso() })
    .eq("id", id)
    .eq("status", "paused")
    .select()
    .maybeSingle();
  if (error) fail("resume", error.message);
  return (data as SmsCampaign) ?? null;
}

/**
 * Reschedule a campaign that has not started sending (`scheduled`/`paused`):
 * recompute send_at from the new date + slot + zone, then sweep every
 * still-`pending` outbox row's send_after to the new instant — including
 * retry-backoff rows in a paused campaign (a reschedule means "everything
 * not yet sent goes at the new time"). Guarded like every transition:
 * `null` = the guard lost (e.g. the dispatcher promoted it to `sending`
 * mid-request) and the caller routes 409.
 */
export async function rescheduleCampaign(
  id: string,
  input: CampaignRescheduleInput,
): Promise<SmsCampaign | null> {
  const parsed = CampaignRescheduleInputSchema.parse(input);
  const sendAt = sendAtForZonedSlot(
    parsed.sendDate,
    parsed.sendTime,
    parsed.sendTimezone,
  ).toISOString();

  const { data, error } = await campaigns()
    .update({
      send_date: parsed.sendDate,
      send_time: parsed.sendTime,
      send_timezone: parsed.sendTimezone,
      send_at: sendAt,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .in("status", ["scheduled", "paused"])
    .select()
    .maybeSingle();
  if (error) fail("reschedule", error.message);
  if (!data) return null;

  const { error: sweepError } = await recipients()
    .update({ send_after: sendAt, updated_at: nowIso() })
    .eq("campaign_id", id)
    .eq("status", "pending");
  if (sweepError) fail("reschedule-recipients", sweepError.message);

  return data as SmsCampaign;
}

/**
 * Cancel a non-terminal campaign and its not-yet-attempted recipients
 * (`pending`/`claimed` → `canceled`). Rows already `sending` are left alone —
 * the in-flight POST completes naturally and cannot be recalled.
 */
export async function cancelCampaign(id: string): Promise<SmsCampaign | null> {
  const { data, error } = await campaigns()
    .update({ status: "canceled", updated_at: nowIso() })
    .eq("id", id)
    .in("status", ["scheduled", "sending", "paused"])
    .select()
    .maybeSingle();
  if (error) fail("cancel", error.message);
  if (!data) return null;

  const { error: sweepError } = await recipients()
    .update({
      status: "canceled",
      claimed_at: null,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("campaign_id", id)
    .in("status", ["pending", "claimed"]);
  if (sweepError) fail("cancel-recipients", sweepError.message);

  return data as SmsCampaign;
}

/**
 * Manual-review retry: re-queue a `failed_ambiguous`/`failed` row as due-now
 * `pending`, and re-open its campaign (`completed` → `sending`) so the
 * dispatcher picks it up. last_error is kept for audit until the next attempt
 * overwrites it.
 *
 * Refuses (null → 409) when the row's campaign is `canceled` BEFORE touching
 * the row: nothing transitions a campaign out of `canceled` and the claim RPC
 * only serves `sending` campaigns, so a `pending` row inside a canceled
 * campaign could never dispatch — and could never be retried or mark_failed
 * again either (both guards exclude `pending`). It would be wedged forever.
 */
export async function retryRecipient(
  id: string,
): Promise<SmsCampaignRecipient | null> {
  const { data: rowData, error: lookupError } = await recipients()
    .select("campaign_id")
    .eq("id", id)
    .maybeSingle();
  if (lookupError) fail("retry-lookup", lookupError.message);
  if (!rowData) return null;
  const campaignId = (rowData as { campaign_id: string }).campaign_id;

  const { data: campaignData, error: statusError } = await campaigns()
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (statusError) fail("retry-campaign-status", statusError.message);
  const campaignStatus = (campaignData as { status: CampaignStatus } | null)
    ?.status;
  if (campaignStatus === "canceled") return null;

  const { data, error } = await recipients()
    .update({
      status: "pending",
      send_after: nowIso(),
      claimed_at: null,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .in("status", ["failed_ambiguous", "failed"])
    .select()
    .maybeSingle();
  if (error) fail("retry-recipient", error.message);
  if (!data) return null;
  const row = data as SmsCampaignRecipient;

  const { error: reopenError } = await campaigns()
    .update({ status: "sending", updated_at: nowIso() })
    .eq("id", row.campaign_id)
    .eq("status", "completed");
  if (reopenError) fail("retry-reopen", reopenError.message);

  return row;
}

/** Manual-review resolution: a `failed_ambiguous` row is declared `failed`. */
export async function markRecipientFailed(
  id: string,
  note?: string,
): Promise<SmsCampaignRecipient | null> {
  const patch: Record<string, unknown> = {
    status: "failed",
    updated_at: nowIso(),
  };
  if (note) patch.last_error = note;

  const { data, error } = await recipients()
    .update(patch)
    .eq("id", id)
    .eq("status", "failed_ambiguous")
    .select()
    .maybeSingle();
  if (error) fail("mark-recipient-failed", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

// ---------------------------------------------------------------------------
// Dispatcher accessors — one poll tick is: promoteDueCampaigns →
// claimDueRecipients → per row markSending → send → markSent/markFailed/
// markRetry/markAmbiguous → completeDrainedCampaigns.
// ---------------------------------------------------------------------------

/**
 * Claim a batch of due outbox rows via the `claim_due_sms_recipients` RPC
 * (FOR UPDATE SKIP LOCKED lives in Postgres — PostgREST cannot express it).
 * The RPC also runs the suppression sweep and crash recovery (expired
 * `claimed` → `pending`, expired `sending` → `failed_ambiguous`).
 */
export async function claimDueRecipients(
  batchSize: number,
  claimTtlSeconds: number,
  freqCapCount = 0,
  freqCapDays = 0,
): Promise<SmsCampaignRecipient[]> {
  const { data, error } = await getServiceClient()
    .schema(SCHEMA)
    .rpc("claim_due_sms_recipients", {
      batch_size: batchSize,
      claim_ttl_seconds: claimTtlSeconds,
      freq_cap_count: freqCapCount,
      freq_cap_days: freqCapDays,
    });
  if (error) fail("claim", error.message);
  return (data ?? []) as SmsCampaignRecipient[];
}

/** Promote due `scheduled` campaigns to `sending`; returns the promoted ids. */
export async function promoteDueCampaigns(
  now: Date = new Date(),
): Promise<string[]> {
  const { data, error } = await campaigns()
    .update({ status: "sending", updated_at: nowIso() })
    .eq("status", "scheduled")
    .lte("send_at", now.toISOString())
    .select("id");
  if (error) fail("promote", error.message);
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

/**
 * The durable `claimed` → `sending` transition that STARTS a POST attempt.
 * `nextAttempts` is the caller-computed attempts+1 (PostgREST cannot
 * increment server-side; the read-modify-write is safe ONLY because of the
 * `.eq('status','claimed')` guard — pause/cancel releases make it match 0
 * rows, in which case this returns null and the caller must NOT send).
 */
export async function markSending(
  id: string,
  nextAttempts: number,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "sending",
      attempts: nextAttempts,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "claimed")
    .select()
    .maybeSingle();
  if (error) fail("mark-sending", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/** 201 outcome: record SimpleTexting's message id + credits. */
export async function markSent(
  id: string,
  result: { stMessageId: string | null; stCredits: number | null },
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "sent",
      st_message_id: result.stMessageId,
      st_credits: result.stCredits,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "sending")
    .select()
    .maybeSingle();
  if (error) fail("mark-sent", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/** Definitive rejection (or retries exhausted): terminal `failed`. */
export async function markFailed(
  id: string,
  detail: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "failed",
      last_error: detail,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "sending")
    .select()
    .maybeSingle();
  if (error) fail("mark-failed", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/**
 * Retryable outcome (provably not processed): back to `pending` with
 * `send_after` pushed to the caller-computed backoff instant.
 */
export async function markRetry(
  id: string,
  sendAfter: Date,
  detail: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "pending",
      send_after: sendAfter.toISOString(),
      last_error: detail,
      claimed_at: null,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "sending")
    .select()
    .maybeSingle();
  if (error) fail("mark-retry", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/**
 * Ambiguous outcome (timeout/ECONNRESET/500 — the POST may have landed):
 * park as `failed_ambiguous`. NEVER auto-retried; webhook reconciliation or
 * manual review resolves it.
 */
export async function markAmbiguous(
  id: string,
  detail: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "failed_ambiguous",
      last_error: detail,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "sending")
    .select()
    .maybeSingle();
  if (error) fail("mark-ambiguous", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/**
 * Return an un-attempted `claimed` row to `pending` (campaign paused/canceled
 * mid-batch, suppression pre-check hit, or SIGTERM drain). Guarded on
 * `claimed`: a row that reached `sending` has started a POST and must resolve
 * through markSent/markFailed/markRetry/markAmbiguous instead.
 */
export async function releaseClaim(
  id: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "pending",
      claimed_at: null,
      claim_expires_at: null,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "claimed")
    .select()
    .maybeSingle();
  if (error) fail("release-claim", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/**
 * 401/403 outcome: the POST was rejected before processing, so the attempt
 * did not really happen — re-queue as `pending` and write back the
 * pre-increment `attempts` the caller remembers (a bad token must not burn a
 * campaign's attempt budget).
 */
export async function releaseForConfigError(
  id: string,
  revertAttempts: number,
  detail: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .update({
      status: "pending",
      attempts: revertAttempts,
      claimed_at: null,
      claim_expires_at: null,
      last_error: detail,
      updated_at: nowIso(),
    })
    .eq("id", id)
    .eq("status", "sending")
    .select()
    .maybeSingle();
  if (error) fail("release-config-error", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

/** Belt-and-suspenders pre-send STOP check for one phone. */
export async function isSuppressed(phone: string): Promise<boolean> {
  const { data, error } = await suppressions()
    .select("phone_e164")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error) fail("is-suppressed", error.message);
  return data !== null;
}

/** Current status per campaign id (one query per claimed batch). */
export async function getCampaignStatuses(
  ids: string[],
): Promise<Map<string, CampaignStatus>> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return new Map();

  const { data, error } = await campaigns()
    .select("id, status")
    .in("id", unique);
  if (error) fail("campaign-statuses", error.message);

  const statuses = new Map<string, CampaignStatus>();
  for (const row of (data ?? []) as Array<{
    id: string;
    status: CampaignStatus;
  }>) {
    statuses.set(row.id, row.status);
  }
  return statuses;
}

/** Recipient statuses that keep a campaign open. */
const ACTIVE_RECIPIENT_STATUSES: RecipientStatus[] = [
  "pending",
  "claimed",
  "sending",
];

/**
 * The subset of `campaignIds` that still have active (pending|claimed|
 * sending) recipient rows, via the counts view — chunked per `.in()` like
 * getSuppressedSet (PostgREST filters travel in the URL).
 */
async function campaignsWithActiveRows(
  campaignIds: string[],
): Promise<Set<string>> {
  const active = new Set<string>();
  for (const chunk of inChunks(campaignIds)) {
    const { data, error } = await countsView()
      .select("campaign_id")
      .in("campaign_id", chunk)
      .in("status", ACTIVE_RECIPIENT_STATUSES);
    if (error) fail("complete-drained-counts", error.message);
    for (const row of (data ?? []) as Array<{ campaign_id: string }>) {
      active.add(row.campaign_id);
    }
  }
  return active;
}

/**
 * Drain check: `sending` campaigns with zero rows left in
 * pending|claimed|sending become `completed`. The final update is still
 * guarded on `status='sending'` so a concurrent pause/cancel (or a
 * retryRecipient re-open) between the check and the update wins.
 *
 * TOCTOU compensation: a retryRecipient that lands between the counts read
 * and the guarded update sees the campaign still `sending` (its re-open
 * matches 0 rows) while our update then completes it — stranding the fresh
 * `pending` row inside a `completed` campaign. After completing, the counts
 * are re-read for just the completed ids and any campaign that regained
 * active rows is re-opened `completed` → `sending`; only campaigns that
 * STAYED completed are returned.
 */
export async function completeDrainedCampaigns(): Promise<string[]> {
  const { data, error } = await campaigns()
    .select("id")
    .eq("status", "sending");
  if (error) fail("complete-drained", error.message);
  const sendingIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (sendingIds.length === 0) return [];

  const active = await campaignsWithActiveRows(sendingIds);

  const drained = sendingIds.filter((id) => !active.has(id));
  if (drained.length === 0) return [];

  const { data: completedRows, error: completeError } = await campaigns()
    .update({ status: "completed", updated_at: nowIso() })
    .in("id", drained)
    .eq("status", "sending")
    .select("id");
  if (completeError) fail("complete-drained-update", completeError.message);
  const completedIds = ((completedRows ?? []) as Array<{ id: string }>).map(
    (r) => r.id,
  );
  if (completedIds.length === 0) return [];

  // Compensating re-check: re-open anything that regained active rows in the
  // race window, guarded on 'completed' so a concurrent pause/cancel wins.
  const reactivated = await campaignsWithActiveRows(completedIds);
  if (reactivated.size > 0) {
    const { error: reopenError } = await campaigns()
      .update({ status: "sending", updated_at: nowIso() })
      .in("id", Array.from(reactivated))
      .eq("status", "completed");
    if (reopenError) fail("complete-drained-reopen", reopenError.message);
  }

  return completedIds.filter((id) => !reactivated.has(id));
}

// ---------------------------------------------------------------------------
// Webhook accessors — STOP suppression + delivery-report reconciliation
// ---------------------------------------------------------------------------

export type SuppressionReason = "stop" | "manual";
export type WebhookKind =
  | "unsubscribe"
  | "delivery_report"
  | "inbound"
  | "unknown";

/**
 * Permanently add a phone to the STOP list. Upsert on the phone_e164 primary
 * key so repeated STOP webhooks are idempotent (latest raw payload wins).
 */
export async function recordSuppression(
  phone: string,
  reason: SuppressionReason,
  raw?: unknown,
): Promise<void> {
  const { error } = await suppressions().upsert(
    { phone_e164: phone, reason, raw: raw ?? null },
    { onConflict: "phone_e164" },
  );
  if (error) fail("record-suppression", error.message);
}

/**
 * STOP fan-out: suppress every not-yet-attempted (`pending`/`claimed`) row
 * for this phone across ALL campaigns. Rows already `sending`/`sent` are
 * history and stay untouched. Returns how many rows were suppressed.
 */
export async function suppressActiveRecipientsByPhone(
  phone: string,
): Promise<number> {
  const { data, error } = await recipients()
    .update({
      status: "suppressed",
      claimed_at: null,
      claim_expires_at: null,
      last_error: "suppressed: phone joined the STOP list",
      updated_at: nowIso(),
    })
    .eq("phone_e164", phone)
    .in("status", ["pending", "claimed"])
    .select("id");
  if (error) fail("suppress-by-phone", error.message);
  return ((data ?? []) as Array<{ id: string }>).length;
}

/**
 * Audit EVERY webhook request (payload shapes are undocumented — the raw
 * rows are the evidence for post-launch heuristic tuning). Returns the
 * event id.
 */
export async function recordWebhookEvent(
  kind: WebhookKind,
  raw: unknown,
  matchedRecipientId?: string | null,
): Promise<string> {
  const { data, error } = await webhookEvents()
    .insert({
      kind,
      raw,
      matched_recipient_id: matchedRecipientId ?? null,
    })
    .select("id")
    .single();
  if (error) fail("record-webhook-event", error.message);
  return (data as { id: string }).id;
}

/**
 * Locate the outbox row a delivery report refers to: by SimpleTexting
 * message id first (exact), else the newest row for the phone still awaiting
 * an outcome (`sent`/`sending`/`failed_ambiguous`) — the phone fallback is
 * what reconciles ambiguous rows whose st_message_id we never learned, so it
 * ONLY considers rows with a null st_message_id (a `sent` row that already
 * carries a DIFFERENT id belongs to another message and must not be matched).
 */
export async function findRecipientForDeliveryReport(lookup: {
  stMessageId?: string | null;
  phone?: string | null;
}): Promise<SmsCampaignRecipient | null> {
  if (lookup.stMessageId) {
    const { data, error } = await recipients()
      .select("*")
      .eq("st_message_id", lookup.stMessageId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) fail("find-by-message-id", error.message);
    const row = ((data ?? []) as SmsCampaignRecipient[])[0];
    if (row) return row;
  }

  if (lookup.phone) {
    const { data, error } = await recipients()
      .select("*")
      .eq("phone_e164", lookup.phone)
      .in("status", ["sent", "sending", "failed_ambiguous"])
      .is("st_message_id", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) fail("find-by-phone", error.message);
    const row = ((data ?? []) as SmsCampaignRecipient[])[0];
    if (row) return row;
  }

  return null;
}

/**
 * Settle a recipient from a delivery report: `delivered`/`undelivered`.
 * Guarded to sent|sending|failed_ambiguous — the failed_ambiguous path IS
 * the automatic reconciliation lane (proof the ambiguous POST landed).
 * Backfills st_message_id when the report carries one we did not know, but
 * NEVER overwrites a different already-learned id: callers pass the row's
 * known value as `currentStMessageId`, and the id is only written when that
 * value is null/unknown or equals the incoming one.
 */
export async function applyDeliveryReport(
  id: string,
  report: {
    delivered: boolean;
    stMessageId?: string | null;
    /** The row's st_message_id as the caller last read it. */
    currentStMessageId?: string | null;
    detail?: string;
  },
): Promise<SmsCampaignRecipient | null> {
  const patch: Record<string, unknown> = {
    status: report.delivered ? "delivered" : "undelivered",
    claim_expires_at: null,
    updated_at: nowIso(),
  };
  if (
    report.stMessageId &&
    (report.currentStMessageId == null ||
      report.currentStMessageId === report.stMessageId)
  ) {
    patch.st_message_id = report.stMessageId;
  }
  if (!report.delivered && report.detail) patch.last_error = report.detail;

  const { data, error } = await recipients()
    .update(patch)
    .eq("id", id)
    .in("status", ["sent", "sending", "failed_ambiguous"])
    .select()
    .maybeSingle();
  if (error) fail("apply-delivery-report", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

// ---------------------------------------------------------------------------
// Tracked links — resolution + click recording for the /l/[slug] redirect.
// ---------------------------------------------------------------------------

/** Longest user agent worth keeping (bot-vs-human triage, not analytics). */
const USER_AGENT_MAX = 512;

/** Resolve a short-link slug to its row id + target, or null when unknown. */
export async function getLinkTarget(
  slug: string,
): Promise<{ id: string; target_url: string } | null> {
  const { data, error } = await links()
    .select("id, target_url")
    .eq("slug", slug)
    .maybeSingle();
  if (error) fail("get-link", error.message);
  return (data as { id: string; target_url: string }) ?? null;
}

/** One click event per redirect served. */
export async function recordLinkClick(
  linkId: string,
  userAgent: string | null,
): Promise<void> {
  const { error } = await linkClicks().insert({
    link_id: linkId,
    user_agent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
  });
  if (error) fail("record-link-click", error.message);
}

// ---------------------------------------------------------------------------
// Inbound messages — the reply inbox behind the webhook's `inbound` lane.
// ---------------------------------------------------------------------------

/** The campaign a reply was attributed to, embedded for list rendering. */
export interface InboundCampaignRef {
  id: string;
  name: string;
}

export interface InboundMessageWithCampaign extends SmsInboundMessage {
  campaign: InboundCampaignRef | null;
}

/** Store one inbound reply (webhook lane). Returns the new row id. */
export async function recordInboundMessage(input: {
  phone: string | null;
  body: string;
  raw: unknown;
  matchedRecipientId?: string | null;
  matchedCampaignId?: string | null;
}): Promise<string> {
  const { data, error } = await inbound()
    .insert({
      phone_e164: input.phone,
      body: input.body,
      raw: input.raw,
      matched_recipient_id: input.matchedRecipientId ?? null,
      matched_campaign_id: input.matchedCampaignId ?? null,
    })
    .select("id")
    .single();
  if (error) fail("record-inbound", error.message);
  return (data as { id: string }).id;
}

/**
 * The outbox row a reply most plausibly responds to: the newest row for the
 * phone that had a message actually leave our system (`sent`/`delivered`/
 * `undelivered`) or is awaiting reconciliation (`failed_ambiguous` — a reply
 * is decent evidence the ambiguous POST landed, though only the human lane
 * may act on that).
 */
export async function findRecipientForInbound(
  phone: string,
): Promise<SmsCampaignRecipient | null> {
  const { data, error } = await recipients()
    .select("*")
    .eq("phone_e164", phone)
    .in("status", ["sent", "delivered", "undelivered", "failed_ambiguous"])
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) fail("find-inbound-recipient", error.message);
  return ((data ?? []) as SmsCampaignRecipient[])[0] ?? null;
}

/** Inbox rows, newest first, with the attributed campaign embedded. */
export async function listInboundMessages(
  opts: { unhandledOnly?: boolean; campaignId?: string; limit?: number } = {},
): Promise<InboundMessageWithCampaign[]> {
  let query = inbound().select("*, campaign:sms_campaigns(id, name)");
  if (opts.unhandledOnly) query = query.eq("handled", false);
  if (opts.campaignId) query = query.eq("matched_campaign_id", opts.campaignId);
  const { data, error } = await query
    .order("received_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) fail("list-inbound", error.message);
  return (data ?? []) as InboundMessageWithCampaign[];
}

/**
 * Flip the inbox workflow bit. Handling stamps who/when; un-handling clears
 * both. Unconditional (last write wins — it's a checkbox, not a state
 * machine); null = row does not exist.
 */
export async function setInboundHandled(
  id: string,
  handled: boolean,
  actor: string,
): Promise<SmsInboundMessage | null> {
  const { data, error } = await inbound()
    .update(
      handled
        ? { handled: true, handled_by: actor, handled_at: nowIso() }
        : { handled: false, handled_by: null, handled_at: null },
    )
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) fail("set-inbound-handled", error.message);
  return (data as SmsInboundMessage) ?? null;
}

/** Inbox badge count. */
export async function countUnhandledInbound(): Promise<number> {
  const { count, error } = await inbound()
    .select("id", { count: "exact", head: true })
    .eq("handled", false);
  if (error) fail("count-unhandled-inbound", error.message);
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Suppression management — the /suppressions page. Manual entries carry their
// provenance in `raw` ({added_by, note}) and every manual add/remove also
// writes an sms_suppression_audit row (TCPA evidence). Webhook 'stop' entries
// are permanent by doctrine and cannot be removed here.
// ---------------------------------------------------------------------------

/** One STOP-list row, or null. */
export async function getSuppression(
  phone: string,
): Promise<SmsSuppression | null> {
  const { data, error } = await suppressions()
    .select("*")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (error) fail("get-suppression", error.message);
  return (data as SmsSuppression) ?? null;
}

/**
 * Newest-first STOP-list slice. `query` is matched against the stored E.164
 * digits (input is stripped to digits/+ first — "(555) 555" finds +1555555…).
 */
export async function listSuppressions(
  opts: { query?: string; limit?: number } = {},
): Promise<SmsSuppression[]> {
  const digits =
    opts.query !== undefined ? opts.query.replace(/[^0-9+]/g, "") : null;
  if (digits !== null && digits.length === 0) return [];

  let q = suppressions().select("*");
  if (digits !== null) q = q.ilike("phone_e164", `%${digits}%`);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) fail("list-suppressions", error.message);
  return (data ?? []) as SmsSuppression[];
}

/** Total STOP-list size (stat card). */
export async function countSuppressions(): Promise<number> {
  const { count, error } = await suppressions().select("phone_e164", {
    count: "exact",
    head: true,
  });
  if (error) fail("count-suppressions", error.message);
  return count ?? 0;
}

/**
 * Best-effort by design: the suppression mutation itself is the
 * safety-critical part and has already committed by the time this runs — an
 * audit failure must NOT fail the request, because a retry could never
 * re-create the evidence (the add would 409, the remove would 404). Failures
 * are logged loudly instead; manual adds also carry their provenance in
 * sms_suppressions.raw as a fallback trail.
 */
async function recordSuppressionAudit(
  phone: string,
  action: "added" | "removed",
  reason: string,
  actor: string,
  note?: string,
): Promise<void> {
  const { error } = await suppressionAudit().insert({
    phone_e164: phone,
    action,
    reason,
    actor,
    note: note ?? null,
  });
  if (error) {
    console.error(
      `[sms] suppression-audit insert failed (${action} ${phone} by ${actor}): ${error.message}`,
    );
  }
}

/**
 * Manually suppress a phone. An existing entry (either reason) is left
 * untouched — a webhook 'stop' must never be downgraded to 'manual' — and
 * reported as `created: false`. A new entry also sweeps the phone's
 * not-yet-attempted outbox rows (same fan-out as a STOP webhook) and writes
 * the audit row.
 */
export async function addManualSuppression(
  phone: string,
  actor: string,
  note?: string,
): Promise<{ created: boolean; suppression: SmsSuppression }> {
  const existing = await getSuppression(phone);
  if (existing) return { created: false, suppression: existing };

  const { data, error } = await suppressions()
    .insert({
      phone_e164: phone,
      reason: "manual",
      raw: { added_by: actor, note: note ?? null },
    })
    .select()
    .maybeSingle();
  if (error) {
    // Insert race (someone else suppressed the phone between the check and
    // the insert): read it back and report created:false; anything else is a
    // real failure.
    const raced = await getSuppression(phone);
    if (raced) return { created: false, suppression: raced };
    fail("add-suppression", error.message);
  }

  const suppression = data as SmsSuppression;
  await suppressActiveRecipientsByPhone(phone);
  await recordSuppressionAudit(phone, "added", "manual", actor, note);
  return { created: true, suppression };
}

/**
 * Remove a MANUAL suppression entry. Webhook 'stop' entries are permanent
 * (the person texted STOP; only a carrier-side re-subscribe may bring them
 * back) — the reason guard makes this a conditional delete: null = nothing
 * removable (missing, or reason 'stop' → caller routes 409).
 */
export async function removeManualSuppression(
  phone: string,
  actor: string,
  note?: string,
): Promise<SmsSuppression | null> {
  const { data, error } = await suppressions()
    .delete()
    .eq("phone_e164", phone)
    .eq("reason", "manual")
    .select()
    .maybeSingle();
  if (error) fail("remove-suppression", error.message);
  if (!data) return null;

  await recordSuppressionAudit(phone, "removed", "manual", actor, note);
  return data as SmsSuppression;
}

// ---------------------------------------------------------------------------
// Needs-attention queue — cross-campaign review of rows that stopped moving.
// ---------------------------------------------------------------------------

/** Statuses that put an outbox row in the needs-attention queue. */
export const ATTENTION_STATUSES: RecipientStatus[] = [
  "failed_ambiguous",
  "failed",
  "undelivered",
];

export interface AttentionCampaignRef {
  id: string;
  name: string;
  status: CampaignStatus;
}

export interface AttentionRecipient extends SmsCampaignRecipient {
  campaign: AttentionCampaignRef | null;
}

/** The review queue, newest problems first, capped for the UI. */
export async function listAttentionRecipients(
  limit = 500,
): Promise<AttentionRecipient[]> {
  const { data, error } = await recipients()
    .select("*, campaign:sms_campaigns(id, name, status)")
    .in("status", ATTENTION_STATUSES)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) fail("list-attention", error.message);
  return (data ?? []) as AttentionRecipient[];
}

/**
 * Manual-review resolution: a human confirmed the ambiguous POST actually
 * landed (delivery receipt seen elsewhere, or the person replied) — settle
 * `failed_ambiguous` → `sent`. The optional note lands in last_error as the
 * audit trail of WHY it was resolved by hand.
 */
export async function resolveRecipientSent(
  id: string,
  note?: string,
): Promise<SmsCampaignRecipient | null> {
  const patch: Record<string, unknown> = {
    status: "sent",
    claim_expires_at: null,
    updated_at: nowIso(),
  };
  if (note) patch.last_error = note;

  const { data, error } = await recipients()
    .update(patch)
    .eq("id", id)
    .eq("status", "failed_ambiguous")
    .select()
    .maybeSingle();
  if (error) fail("resolve-recipient-sent", error.message);
  return (data as SmsCampaignRecipient) ?? null;
}

// ---------------------------------------------------------------------------
// Engagement aggregates — the sms_campaign_engagement view.
// ---------------------------------------------------------------------------

function zeroEngagement(campaignId: string): CampaignEngagement {
  return {
    campaign_id: campaignId,
    tracked_links: 0,
    recipients_clicked: 0,
    total_clicks: 0,
    replies: 0,
    unhandled_replies: 0,
    opt_outs: 0,
  };
}

/** One campaign's engagement aggregates (zero-filled when the view has none). */
export async function getCampaignEngagement(
  campaignId: string,
): Promise<CampaignEngagement> {
  const { data, error } = await engagementView()
    .select("*")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (error) fail("get-engagement", error.message);
  return (data as CampaignEngagement) ?? zeroEngagement(campaignId);
}

/** Engagement rows for many campaigns, chunked like every `.in()` here. */
export async function getEngagementForCampaigns(
  ids: string[],
): Promise<Map<string, CampaignEngagement>> {
  const map = new Map<string, CampaignEngagement>();
  for (const chunk of inChunks(Array.from(new Set(ids)))) {
    const { data, error } = await engagementView()
      .select("*")
      .in("campaign_id", chunk);
    if (error) fail("engagement-for-campaigns", error.message);
    for (const row of (data ?? []) as CampaignEngagement[]) {
      map.set(row.campaign_id, row);
    }
  }
  return map;
}
