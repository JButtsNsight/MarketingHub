// Pure module — imported by client components and the worker alike. Nothing
// server-only or node-only may be imported here.

/**
 * NANP shape after country code: 10 digits, area code starting 2-9. We only
 * enforce the area-code rule — anything stricter risks rejecting real
 * patient numbers over stale NANP trivia.
 */
const US_TEN_DIGIT = /^[2-9]\d{9}$/;

/**
 * Normalize a raw phone value (Monday cell, pasted text, …) to `+1XXXXXXXXXX`.
 * US numbers only — v1 sends via a US SimpleTexting account.
 *
 * @param raw phone text in any common formatting.
 * @param countryShortName Monday's `country_short_name` when available; any
 *   value other than `US` (or blank/unknown) rejects the number outright.
 * @returns E.164 `+1...` string, or null when the number is not a usable US
 *   number (callers mark those rows `skipped`).
 */
export function normalizeUsPhone(
  raw: string,
  countryShortName?: string,
): string | null {
  const hint = countryShortName?.trim().toUpperCase();
  if (hint && hint !== "US") return null;

  // Strip every non-digit (spaces, dashes, dots, parens, leading +). Letters
  // vanish too, so vanity numbers fail the digit-count checks below.
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  if (!US_TEN_DIGIT.test(digits)) return null;

  return `+1${digits}`;
}
