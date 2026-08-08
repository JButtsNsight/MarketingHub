import { z } from "zod";
import type { Tables } from "../database.types";
import { isWeekday, SEND_SLOTS, SEND_TIMEZONE_IDS } from "./schedule";

// Pure module — imported by client components and the worker alike. Nothing
// server-only or node-only may be imported here.

/** Campaign lifecycle states. Mirrors the DB `status` check constraint. */
export const CAMPAIGN_STATUSES = [
  "scheduled",
  "sending",
  "paused",
  "completed",
  "canceled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Recipient (outbox row) states. Mirrors the DB `status` check constraint. */
export const RECIPIENT_STATUSES = [
  "pending",
  "claimed",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "failed_ambiguous",
  "suppressed",
  "skipped",
  "canceled",
  "frequency_capped",
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/**
 * `YYYY-MM-DD`, a real calendar date (rejects 2026-02-30 etc.), and a
 * Monday–Friday — blasts only go out on weekdays. The send instant is
 * computed from date + slot + zone in schedule.ts.
 */
const sendDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "sendDate must be YYYY-MM-DD")
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number);
      const roundTrip = new Date(Date.UTC(year, month - 1, day));
      return (
        roundTrip.getUTCFullYear() === year &&
        roundTrip.getUTCMonth() === month - 1 &&
        roundTrip.getUTCDate() === day
      );
    },
    { message: "sendDate must be a real calendar date" },
  )
  .refine(isWeekday, {
    message: "sendDate must be a weekday (Mon–Fri)",
  });

/** One of the 30-minute blast slots (8:00 AM – 1:00 PM wall clock). */
const sendTimeSchema = z.enum(SEND_SLOTS, {
  errorMap: () => ({
    message: "sendTime must be a 30-minute slot between 08:00 and 13:00",
  }),
});

/** One of the US send zones (ET/CT/MT/PT/HT). */
const sendTimezoneSchema = z.enum(SEND_TIMEZONE_IDS, {
  errorMap: () => ({ message: "sendTimezone must be a US send zone" }),
});

/**
 * Validated input for creating an SMS campaign. The audience is a saved
 * contact list (uploaded sheet or linked Monday board) — its Monday
 * coordinates, when it has them, are read from the list row server-side.
 */
export const CampaignCreateInputSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  templateId: z.string().uuid("templateId must be a UUID"),
  contactListId: z.string().uuid("contactListId must be a UUID"),
  sendDate: sendDateSchema,
  sendTime: sendTimeSchema,
  sendTimezone: sendTimezoneSchema,
});

/** Validated create-input. */
export type CampaignCreateInput = z.infer<typeof CampaignCreateInputSchema>;

/** Validated input for rescheduling a not-yet-sending campaign. */
export const CampaignRescheduleInputSchema = z.object({
  sendDate: sendDateSchema,
  sendTime: sendTimeSchema,
  sendTimezone: sendTimezoneSchema,
});
export type CampaignRescheduleInput = z.infer<
  typeof CampaignRescheduleInputSchema
>;

/** A row of `marketinghub.sms_campaigns`. */
export interface SmsCampaign {
  id: string;
  name: string;
  template_id: string;
  /** The saved recipient source; null only on pre-lists legacy campaigns. */
  contact_list_id: string | null;
  /** Monday coordinates — null for campaigns built from an uploaded sheet. */
  monday_board_id: string | null;
  monday_phone_column_id: string | null;
  /** Template body snapshot taken at creation time. */
  message_body: string;
  /** `YYYY-MM-DD` chosen by the user (a weekday, in the chosen zone). */
  send_date: string;
  /** The chosen 30-minute slot, wall clock `HH:MM` (08:00–13:00). */
  send_time: string;
  /** IANA zone the slot is anchored to (one of the US send zones). */
  send_timezone: string;
  /** The computed send instant, as timestamptz. */
  send_at: string;
  status: CampaignStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Generated row type for `marketinghub.sms_campaigns` (scripts/gen-db-types.sh). */
type GeneratedSmsCampaignRow = Tables<{ schema: "marketinghub" }, "sms_campaigns">;

// Compile-time drift checks against the generated types (type-only — the
// `satisfies` operator and both consts erase to nothing observable). If the
// DB adds/retypes a column, the first check fails; if the interface carries a
// column the DB no longer has, the keyof check fails. Fix = regenerate via
// scripts/gen-db-types.sh and reconcile the interface above.
const _smsCampaignSatisfiesGeneratedRow = {} as SmsCampaign satisfies GeneratedSmsCampaignRow;
const _smsCampaignKeysExistInGeneratedRow = {} as keyof SmsCampaign satisfies keyof GeneratedSmsCampaignRow;
void _smsCampaignSatisfiesGeneratedRow;
void _smsCampaignKeysExistInGeneratedRow;

/** A row of `marketinghub.sms_campaign_recipients` (the outbox). */
export interface SmsCampaignRecipient {
  id: string;
  campaign_id: string;
  /** Null for recipients that came from an uploaded sheet, not Monday. */
  monday_item_id: string | null;
  name: string;
  first_name: string;
  /** Null for skipped rows (invalid/duplicate phone) — raw noted in last_error. */
  phone_e164: string | null;
  /** Per-recipient rendered message snapshot (audit). */
  rendered_text: string;
  status: RecipientStatus;
  /** POST attempts *started* (incremented on the claimed → sending transition). */
  attempts: number;
  /** Due instant; starts at the campaign's send_at, bumped by retry backoff. */
  send_after: string;
  claimed_at: string | null;
  claim_expires_at: string | null;
  st_message_id: string | null;
  st_credits: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** A row of the `sms_campaign_recipient_counts` view: campaign × status × n. */
export interface CampaignCounts {
  campaign_id: string;
  status: RecipientStatus;
  count: number;
}

/** A row of `marketinghub.sms_links` — one tracked short link per recipient × URL. */
export interface SmsLink {
  id: string;
  slug: string;
  campaign_id: string;
  recipient_id: string;
  target_url: string;
  created_at: string;
}

/** A row of `marketinghub.sms_inbound_messages` — the reply inbox. */
export interface SmsInboundMessage {
  id: string;
  phone_e164: string | null;
  body: string;
  received_at: string;
  /** Best-effort match to the outbox row that prompted the reply. */
  matched_recipient_id: string | null;
  matched_campaign_id: string | null;
  handled: boolean;
  handled_by: string | null;
  handled_at: string | null;
  raw: unknown;
}

/** A row of `marketinghub.sms_suppressions` — the permanent STOP list. */
export interface SmsSuppression {
  phone_e164: string;
  reason: "stop" | "manual";
  raw: unknown;
  created_at: string;
}

/** A row of the `sms_campaign_engagement` view — per-campaign aggregates. */
export interface CampaignEngagement {
  campaign_id: string;
  tracked_links: number;
  recipients_clicked: number;
  total_clicks: number;
  replies: number;
  unhandled_replies: number;
  opt_outs: number;
}
