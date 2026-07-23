// Pure module — imported by client components and the worker alike. Nothing
// server-only or node-only may be imported here.

/** Matches `{{ anything-but-braces }}` merge tokens. */
const MERGE_TOKEN = /\{\{([^{}]*)\}\}/g;

/** Case/space-insensitive canonical form of a merge-field key. */
function normalizeKey(rawKey: string): string {
  return rawKey.replace(/\s+/g, "").toLowerCase();
}

/** The only merge fields SMS templates support (normalized form). */
const SUPPORTED_KEYS = new Set(["name", "firstname"]);

/**
 * First word of a full name (for `{{firstName}}`). Trailing commas are
 * stripped so "Smith, John" cells don't render "Hi Smith,". Blank → "".
 */
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.replace(/,+$/, "");
}

/**
 * Merge fields in `body` that renderSms would NOT substitute. Used at
 * creation time to reject templates we can't fully render. Returns the
 * first-seen spelling of each unknown field (case/space variants collapse).
 */
export function unsupportedMergeFields(body: string): string[] {
  const unsupported = new Map<string, string>();
  for (const match of body.matchAll(MERGE_TOKEN)) {
    const key = normalizeKey(match[1]);
    if (!SUPPORTED_KEYS.has(key) && !unsupported.has(key)) {
      unsupported.set(key, match[1].trim());
    }
  }
  return Array.from(unsupported.values());
}

/**
 * Render an SMS body for one recipient. `{{name}}` / `{{firstName}}` are
 * case/space tolerant ("{{ First Name }}" works); `firstName` defaults to
 * `firstNameOf(name)`. Unsupported tokens pass through untouched — creation
 * rejects them via unsupportedMergeFields, so this never silently drops data.
 */
export function renderSms(
  body: string,
  fields: { name: string; firstName?: string },
): string {
  const values: Record<string, string> = {
    name: fields.name,
    firstname: fields.firstName ?? firstNameOf(fields.name),
  };
  return body.replace(MERGE_TOKEN, (token, rawKey: string) => {
    const value = values[normalizeKey(rawKey)];
    return value === undefined ? token : value;
  });
}
