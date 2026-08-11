// Pure module — imported by client components and tests alike. Nothing
// server-only or node-only may be imported here.

import { normalizeUsPhone } from "../sms/phone";
import { firstNameOf } from "../sms/render";

/**
 * CSV/TSV contact-sheet parsing for contact lists. RFC 4180-ish: quoted
 * fields (embedded delimiters, quotes, and newlines), CRLF/LF, and a
 * delimiter sniffed from the header line (comma vs tab). Excel users export
 * as CSV — .xlsx binaries are rejected upstream by the upload form/route.
 */

/** One parsed sheet row, classified exactly like Monday board recipients. */
export interface ParsedContact {
  name: string;
  firstName: string;
  /** Normalized `+1XXXXXXXXXX`, or null when not a usable US number. */
  phoneE164: string | null;
  /** The raw phone cell, kept for audit. */
  rawPhone: string;
  reason: "ok" | "invalid" | "duplicate";
  /**
   * Consent provenance, verbatim from the sheet when it carries consent
   * columns (see CONSENT_*_HEADERS) — audit evidence of what was claimed at
   * import time, never parsed or validated. Absent when the sheet has no
   * consent columns.
   */
  consentSource?: string | null;
  consentDate?: string | null;
  /**
   * Recipient zone, verbatim from the sheet (blank cell → null) — stored
   * verbatim on the member row too. Normalized to an IANA send zone at
   * CAMPAIGN time (api/campaigns route): unknown values fall back to the
   * campaign zone with a per-row note, never a hard reject. Absent when the
   * sheet has no timezone column.
   */
  timezone?: string | null;
}

export interface ParsedSheet {
  contacts: ParsedContact[];
  counts: { ok: number; invalid: number; duplicate: number; total: number };
  /** Header titles the phone/name columns resolved to (for UI confirmation). */
  phoneHeader: string;
  nameHeader: string | null;
  timezoneHeader: string | null;
}

export class SheetParseError extends Error {}

/** Split raw text into rows of cells, honoring quoted fields. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);

  // Drop rows that are entirely blank (trailing newline artifacts included).
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

/** Canonical form of a header title for matching. */
function headerKey(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const PHONE_HEADERS = [
  "phone",
  "phonenumber",
  "mobile",
  "mobilephone",
  "mobilenumber",
  "cell",
  "cellphone",
  "cellnumber",
  "number",
  "tel",
  "telephone",
];

const NAME_HEADERS = [
  "name",
  "fullname",
  "patientname",
  "contactname",
  "patient",
  "contact",
];

const FIRST_NAME_HEADERS = ["firstname", "first", "givenname"];
const LAST_NAME_HEADERS = ["lastname", "last", "surname", "familyname"];

/**
 * Consent provenance columns. Date candidates are matched FIRST and excluded
 * from the source search — the bare "consent"/"optin" prefixes would
 * otherwise swallow a "consent date" column when no source column exists.
 */
const CONSENT_DATE_HEADERS = [
  "consentdate",
  "optindate",
  "consenttimestamp",
  "optintimestamp",
  "consentedat",
  "optedinat",
];
const CONSENT_SOURCE_HEADERS = [
  "consentsource",
  "optinsource",
  "consentmethod",
  "optinmethod",
  "consent",
  "optin",
];

/** Recipient-zone column. "time zone" collapses to "timezone" via headerKey. */
const TIMEZONE_HEADERS = ["timezone", "tz", "zone"];

function findHeader(
  headers: string[],
  candidates: string[],
  exclude = -1,
): number {
  const keys = headers.map(headerKey);
  for (const candidate of candidates) {
    const idx = keys.indexOf(candidate);
    if (idx !== -1 && idx !== exclude) return idx;
  }
  // Second pass: prefix match ("phone (mobile)" → phonemobile).
  for (const candidate of candidates) {
    const idx = keys.findIndex(
      (k, i) => i !== exclude && k.startsWith(candidate),
    );
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Parse a contact sheet into classified contacts. Requirements: a header row
 * with a recognizable phone column. The name column is optional — a
 * first/last pair is joined, and a missing name falls back to "".
 * Classification mirrors the Monday path: unusable phone → `invalid`,
 * repeated phone (first occurrence wins) → `duplicate`, else `ok`.
 */
export function parseContactSheet(text: string): ParsedSheet {
  const clean = text.replace(/^﻿/, ""); // strip a UTF-8 BOM
  if (!clean.trim()) throw new SheetParseError("The file is empty.");

  const headerLine = clean.slice(0, clean.indexOf("\n") + 1 || clean.length);
  const delimiter =
    (headerLine.match(/\t/g)?.length ?? 0) >
    (headerLine.match(/,/g)?.length ?? 0)
      ? "\t"
      : ",";

  const rows = splitRows(clean, delimiter);
  if (rows.length < 2) {
    throw new SheetParseError(
      "The file needs a header row and at least one contact row.",
    );
  }

  const headers = rows[0];
  const phoneIdx = findHeader(headers, PHONE_HEADERS);
  if (phoneIdx === -1) {
    throw new SheetParseError(
      "No phone column found — the header row needs a column like " +
        '"phone", "mobile", or "cell".',
    );
  }

  const nameIdx = findHeader(headers, NAME_HEADERS);
  const firstIdx = findHeader(headers, FIRST_NAME_HEADERS);
  const lastIdx = findHeader(headers, LAST_NAME_HEADERS);
  const consentDateIdx = findHeader(headers, CONSENT_DATE_HEADERS);
  const consentSourceIdx = findHeader(
    headers,
    CONSENT_SOURCE_HEADERS,
    consentDateIdx,
  );
  const hasConsent = consentSourceIdx !== -1 || consentDateIdx !== -1;
  const timezoneIdx = findHeader(headers, TIMEZONE_HEADERS);

  const timezoneOf = (row: string[]): Pick<ParsedContact, "timezone"> => {
    if (timezoneIdx === -1) return {};
    return { timezone: (row[timezoneIdx] ?? "").trim() || null };
  };

  const consentOf = (
    row: string[],
  ): Pick<ParsedContact, "consentSource" | "consentDate"> => {
    if (!hasConsent) return {};
    return {
      consentSource:
        consentSourceIdx !== -1
          ? (row[consentSourceIdx] ?? "").trim() || null
          : null,
      consentDate:
        consentDateIdx !== -1
          ? (row[consentDateIdx] ?? "").trim() || null
          : null,
    };
  };

  const nameOf = (row: string[]): string => {
    if (nameIdx !== -1 && row[nameIdx]?.trim()) return row[nameIdx].trim();
    const first = firstIdx !== -1 ? (row[firstIdx] ?? "").trim() : "";
    const last = lastIdx !== -1 ? (row[lastIdx] ?? "").trim() : "";
    return [first, last].filter(Boolean).join(" ");
  };

  const seen = new Set<string>();
  const contacts: ParsedContact[] = rows.slice(1).map((row) => {
    const rawPhone = (row[phoneIdx] ?? "").trim();
    const name = nameOf(row);
    const firstName =
      firstIdx !== -1 && row[firstIdx]?.trim()
        ? row[firstIdx].trim()
        : firstNameOf(name);
    const phoneE164 = normalizeUsPhone(rawPhone);

    const consent = consentOf(row);
    const tz = timezoneOf(row);

    if (!phoneE164) {
      return { name, firstName, phoneE164: null, rawPhone, reason: "invalid" as const, ...consent, ...tz };
    }
    if (seen.has(phoneE164)) {
      // Duplicates must not carry the phone: the DB member table has
      // `unique (list_id, phone_e164)` and nulls are distinct.
      return { name, firstName, phoneE164: null, rawPhone, reason: "duplicate" as const, ...consent, ...tz };
    }
    seen.add(phoneE164);
    return { name, firstName, phoneE164, rawPhone, reason: "ok" as const, ...consent, ...tz };
  });

  const counts = { ok: 0, invalid: 0, duplicate: 0, total: contacts.length };
  for (const c of contacts) counts[c.reason] += 1;

  return {
    contacts,
    counts,
    phoneHeader: headers[phoneIdx].trim(),
    nameHeader:
      nameIdx !== -1
        ? headers[nameIdx].trim()
        : firstIdx !== -1
          ? headers[firstIdx].trim()
          : null,
    timezoneHeader: timezoneIdx !== -1 ? headers[timezoneIdx].trim() : null,
  };
}
