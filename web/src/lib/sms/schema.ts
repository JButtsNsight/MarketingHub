import { z } from "zod";
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

/** One of the four US send zones. */
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
  /** IANA zone the slot is anchored to (one of the four US send zones). */
  send_timezone: string;
  /** The computed send instant, as timestamptz. */
  send_at: string;
  status: CampaignStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

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
