import "server-only";

import { getServiceClient } from "../supabase";
import {
  CampaignCreateInputSchema,
  RECIPIENT_STATUSES,
  type CampaignCounts,
  type CampaignCreateInput,
  type RecipientStatus,
  type SmsCampaign,
  type SmsCampaignRecipient,
} from "./schema";
import { firstNameOf, renderSms } from "./render";
import { sendAtForEasternDate } from "./schedule";

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
/** campaign_id × status × count view (security_invoker). */
const COUNTS_VIEW = "sms_campaign_recipient_counts";

/** Max values per PostgREST `.in()` filter (URL-length safety). */
const IN_CHUNK = 200;
/** Recipient rows per insert statement at creation time. */
const INSERT_CHUNK = 200;

/** Minimal identity to stamp ownership (Cognito user is compatible). */
export interface CampaignCreator {
  email: string;
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

function fail(op: string, message: string): never {
  throw new Error(`[sms] ${op} failed: ${message}`);
}

/** updated_at is app-maintained (no DB trigger) — stamp it on every update. */
function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * One recipient as extracted from a Monday board (Phase 4
 * `fetchBoardRecipients` output is structurally compatible).
 */
export interface MondayRecipientRow {
  mondayItemId: string;
  name: string;
  firstName: string;
  phoneE164: string | null;
  rawPhone: string;
}

/** Creation-time statuses — everything else is owned by the dispatcher. */
export type PreparedRecipientStatus = Extract<
  RecipientStatus,
  "pending" | "suppressed" | "skipped"
>;

/** An outbox row ready to insert (campaign_id/send_after added by create). */
export interface PreparedRecipient {
  monday_item_id: string;
  name: string;
  first_name: string;
  phone_e164: string | null;
  rendered_text: string;
  status: PreparedRecipientStatus;
  last_error: string | null;
}

/**
 * Pure creation-time classification of Monday rows into outbox rows:
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
  mondayRows: MondayRecipientRow[],
  body: string,
  suppressedSet: ReadonlySet<string>,
): PreparedRecipient[] {
  const seenPhones = new Set<string>();

  return mondayRows.map((row) => {
    const firstName = row.firstName.trim() || firstNameOf(row.name);
    const base = {
      monday_item_id: row.mondayItemId,
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
 * no multi-statement transactions) — acceptable at hundreds of rows: on a
 * chunk failure the campaign is best-effort marked `canceled` (so a partial
 * outbox can never send) and the error is re-thrown.
 */
export async function createCampaign(
  input: CampaignCreateInput,
  messageBody: string,
  prepared: PreparedRecipient[],
  user: CampaignCreator,
): Promise<SmsCampaign> {
  const parsed = CampaignCreateInputSchema.parse(input);
  const sendAt = sendAtForEasternDate(parsed.sendDate).toISOString();

  const { data, error } = await campaigns()
    .insert({
      name: parsed.name,
      template_id: parsed.templateId,
      monday_board_id: parsed.mondayBoardId,
      monday_phone_column_id: parsed.mondayPhoneColumnId,
      message_body: messageBody,
      send_date: parsed.sendDate,
      send_at: sendAt,
      status: "scheduled",
      created_by: user.email,
    })
    .select()
    .single();
  if (error) fail("create", error.message);
  const campaign = data as SmsCampaign;

  const rows = prepared.map((r) => ({
    ...r,
    campaign_id: campaign.id,
    send_after: sendAt,
  }));

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { error: insertError } = await recipients().insert(chunk);
    if (insertError) {
      // Best-effort: a partially-populated campaign must never dispatch.
      try {
        await campaigns()
          .update({ status: "canceled", updated_at: nowIso() })
          .eq("id", campaign.id);
      } catch {
        // the original failure is the one worth surfacing
      }
      fail(
        "create-recipients",
        `chunk at ${i} (campaign ${campaign.id} canceled): ${insertError.message}`,
      );
    }
  }

  return campaign;
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

  const { data: countRows, error: countsError } = await countsView()
    .select("*")
    .in(
      "campaign_id",
      rows.map((c) => c.id),
    );
  if (countsError) fail("list-counts", countsError.message);
  const byCampaign = foldCounts((countRows ?? []) as CampaignCounts[]);

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
 */
export async function retryRecipient(
  id: string,
): Promise<SmsCampaignRecipient | null> {
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
