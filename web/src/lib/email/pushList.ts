import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "../supabase";

/**
 * Loads a CSV list's stored members as EmailBison-pushable leads (Email
 * Campaign Center). Same house rules as the contacts repo: `marketinghub`
 * schema via the service-role PostgREST client, fail loud on PostgREST
 * errors. Reads page by page so the email filter and the push cap see EVERY
 * stored member, not the UI's capped slice. The `email` column lands with the
 * CSV-ingest migration and is not in the generated types yet — rows are
 * coerced defensively (missing column = no email), never trusted.
 */

const SCHEMA = "marketinghub";
const MEMBERS = "contact_list_members";
/** Rows per PostgREST page — stays under the server max-rows setting. */
const PAGE_SIZE = 1_000;
/** Usable-email ceiling: one campaign push is not a bulk migration tool. */
export const PUSH_LIST_CAP = 10_000;

export interface PushableLead {
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface PushableLeadsResult {
  leads: PushableLead[];
  /** Members without a plausible email (blank, missing, or no @/dot). */
  skipped: number;
  /** Usable emails exceeded PUSH_LIST_CAP — `leads` is partial, do not push. */
  overCap: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * first_name wins when the sheet had one; otherwise the name's first token.
 * Last name = the remainder of the full name once the first name is removed.
 */
function splitName(
  name: string,
  firstName: string,
): { firstName?: string; lastName?: string } {
  const full = name.trim().replace(/\s+/g, " ");
  const first = firstName.trim() || full.split(" ")[0] || "";
  // Strip `first` off the full name only at a WORD boundary — a first name
  // that merely prefixes the first word ("Jo" vs "John Smith") must not
  // bisect it into "hn Smith".
  const lowered = full.toLowerCase();
  const firstLowered = first.toLowerCase();
  const last =
    first !== "" &&
    (lowered === firstLowered || lowered.startsWith(`${firstLowered} `))
      ? full.slice(first.length).trim()
      : full.split(" ").slice(1).join(" ");
  return {
    ...(first !== "" ? { firstName: first } : {}),
    ...(last !== "" ? { lastName: last } : {}),
  };
}

/**
 * Every member of the list with a plausible email (contains @ and a dot —
 * EmailBison enforces the real format), in upload order. The `reason` column
 * classifies PHONE validity, so it does not gate an email push. Stops
 * fetching as soon as the cap is exceeded.
 */
export async function loadPushableLeads(
  listId: string,
  db: SupabaseClient = getServiceClient(),
): Promise<PushableLeadsResult> {
  const leads: PushableLead[] = [];
  // Duplicate-suppression by lowercased email: CSV re-uploads store the dup
  // row (reason "duplicate" classifies phones, not emails), and pushing the
  // same address twice in one batch would double-count `attached`.
  const seen = new Set<string>();
  let skipped = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .schema(SCHEMA)
      .from(MEMBERS)
      .select("*")
      .eq("list_id", listId)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`[push-list] load-members failed: ${error.message}`);
    }
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const email = str(row.email).trim();
      if (!email.includes("@") || !email.includes(".")) {
        skipped += 1;
        continue;
      }
      const key = email.toLowerCase();
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      leads.push({ email, ...splitName(str(row.name), str(row.first_name)) });
      if (leads.length > PUSH_LIST_CAP) return { leads, skipped, overCap: true };
    }
    if (rows.length < PAGE_SIZE) return { leads, skipped, overCap: false };
  }
}
