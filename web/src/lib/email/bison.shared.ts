// Client-safe EmailBison pieces: types + pure helpers shared by the server
// client (bison.ts, server-only) and the Email Campaign Center UI. No SDK
// imports and no secret access here.

/** One campaign row, shaped for the Email Campaign Center table. */
export interface BisonCampaign {
  id: number;
  uuid: string;
  name: string;
  status: string;
  emailsSent: number;
  uniqueOpens: number;
  uniqueReplies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
  totalLeads: number;
  updatedAt: string | null;
}

export interface BisonPage {
  currentPage: number;
  lastPage: number;
  total: number;
}

/** Campaign status filter values accepted by GET /api/campaigns. */
export const BISON_STATUS_FILTERS = [
  "draft",
  "launching",
  "active",
  "stopped",
  "completed",
  "paused",
  "failed",
  "queued",
  "archived",
] as const;
export type BisonStatusFilter = (typeof BISON_STATUS_FILTERS)[number];

/**
 * Normalize an operator-pasted instance URL to `https://<host>` — accepts a
 * bare host, strips paths (incl. a pasted `/api`), rejects non-https schemes.
 * Returns null when it can't be made into a safe https origin.
 */
export function normalizeBaseUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  return `https://${url.host}`;
}
