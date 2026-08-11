import { SEND_TIMEZONES, type SendTimezone } from "./schedule";

// Pure, dependency-free module — imported by client components and the
// worker alike. Nothing server-only or node-only may be imported here.

/** Lowercased alias → send zone id: the IANA id and the US abbreviation of
 * each send zone ("america/new_york" and "et" → "America/New_York"). */
const ZONE_BY_ALIAS: ReadonlyMap<string, SendTimezone> = new Map(
  SEND_TIMEZONES.flatMap((zone) => [
    [zone.id.toLowerCase(), zone.id] as const,
    [zone.abbr.toLowerCase(), zone.id] as const,
  ]),
);

/**
 * Normalizes a recipient-supplied zone value (a CSV cell or a Monday column
 * value) to one of the US send zones. Accepts IANA ids and the ET/CT/MT/PT/HT
 * abbreviations, tolerant of case and surrounding whitespace. Anything else —
 * including empty/null — returns null, and callers fall back to the campaign
 * zone (a bad cell must never hard-reject a recipient).
 */
export function normalizeRecipientZone(
  raw: string | null | undefined,
): SendTimezone | null {
  if (raw == null) return null;
  return ZONE_BY_ALIAS.get(raw.trim().toLowerCase()) ?? null;
}
