import type { CampaignStatus, RecipientStatus } from "@/lib/sms/schema";

/** Any campaign- or recipient-lifecycle status shown as a Badge in the UI. */
export type SmsStatus = CampaignStatus | RecipientStatus;

/**
 * Status → Badge `tone` token. Governed by the NSight status language: red
 * (--fail) is reserved EXCLUSIVELY for failure, blue (--run) for actively
 * running work, green (--ok) for successful outcomes, orange (--warn) for
 * paused, and `undefined` (the neutral hairline badge) for waiting states.
 * Inert terminal states (canceled/skipped/suppressed) are muted (--idle).
 */
const TONES: Record<SmsStatus, string | undefined> = {
  // failure — the only red in the campaigns UI
  failed: "var(--fail)",
  failed_ambiguous: "var(--fail)",
  undelivered: "var(--fail)",
  // actively dispatching
  sending: "var(--run)",
  claimed: "var(--run)",
  // successful outcomes
  delivered: "var(--ok)",
  completed: "var(--ok)",
  sent: "var(--ok)",
  // needs attention to move again
  paused: "var(--warn)",
  // waiting — neutral badge
  scheduled: undefined,
  pending: undefined,
  // inert terminal states
  canceled: "var(--idle)",
  skipped: "var(--idle)",
  suppressed: "var(--idle)",
};

/** Badge tone for a status, or undefined for the neutral badge. */
export function statusTone(status: SmsStatus): string | undefined {
  return TONES[status];
}

/** Human label for a status ("failed_ambiguous" → "failed ambiguous"). */
export function statusLabel(status: SmsStatus): string {
  return status.replace(/_/g, " ");
}
