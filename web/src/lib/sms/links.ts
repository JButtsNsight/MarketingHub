// Pure module — link extraction + tracked-link rewriting for SMS bodies.
// Imported by server code at campaign-creation time; nothing server-only or
// node-only here (crypto comes from the WebCrypto global, present in Node 18+
// and every browser).

/** One tracked link to persist: the slug embedded in the text + its target. */
export interface TrackedLink {
  slug: string;
  targetUrl: string;
}

/** A rewritten SMS body plus the links that must be persisted alongside it. */
export interface RewriteResult {
  text: string;
  links: TrackedLink[];
}

/**
 * Matches http(s) URLs in free text. SMS bodies put URLs mid-sentence, so
 * trailing punctuation that regs greedily swallow (`.` `,` `)` `!` …) is
 * trimmed after the match.
 */
const URL_PATTERN = /https?:\/\/\S+/gi;
const TRAILING_PUNCTUATION = /[).,!?;:'"\]]+$/;

/** Strip sentence punctuation a greedy URL match swallowed. */
function trimUrl(raw: string): string {
  return raw.replace(TRAILING_PUNCTUATION, "");
}

/** A bare scheme with nothing after it is not a link worth tracking. */
const EMPTY_URL = /^https?:\/\/$/i;

/** All http(s) URLs in `text`, in order of appearance, punctuation-trimmed. */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return matches.map(trimUrl).filter((url) => !EMPTY_URL.test(url));
}

/**
 * Unambiguous base62 — no charset trimming: slugs are never hand-typed, they
 * travel inside the SMS as a full URL.
 */
const SLUG_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SLUG_LENGTH = 8;

/**
 * Crypto-random base62 slug. 62^8 ≈ 2.2e14 — collisions across a campaign are
 * effectively impossible; the DB unique constraint on slug is the final word
 * (an insert collision fails loud at creation time, before anything sends).
 */
export function generateSlug(length: number = SLUG_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const byte of bytes) {
    slug += SLUG_ALPHABET[byte % SLUG_ALPHABET.length];
  }
  return slug;
}

/**
 * Rewrite every URL in a rendered SMS body to a tracked short link
 * (`<linkBase>/l/<slug>`), returning the new text plus the slug → target
 * pairs to persist. Each occurrence gets its own slug — two links in one
 * message stay separately attributable.
 *
 * URLs already under `linkBase` are left alone (idempotence: a template that
 * pastes an existing short link must not be double-wrapped).
 */
/** The creation-time outbox-row shape link tracking needs (structural). */
export interface LinkTrackable {
  rendered_text: string;
  status: string;
  links?: TrackedLink[];
}

/**
 * Apply tracked-link rewriting to creation-time outbox rows. Only `pending`
 * rows are rewritten — they are the ones that may send; skipped/suppressed
 * rows keep their original rendered_text as the audit snapshot of what WOULD
 * have gone out. Rows whose body has no URLs come back untouched.
 */
export function applyLinkTracking<T extends LinkTrackable>(
  rows: T[],
  linkBase: string,
  makeSlug: () => string = generateSlug,
): T[] {
  return rows.map((row) => {
    if (row.status !== "pending") return row;
    const { text, links } = rewriteWithTrackedLinks(
      row.rendered_text,
      linkBase,
      makeSlug,
    );
    if (links.length === 0) return row;
    return { ...row, rendered_text: text, links };
  });
}

export function rewriteWithTrackedLinks(
  text: string,
  linkBase: string,
  makeSlug: () => string = generateSlug,
): RewriteResult {
  const base = linkBase.replace(/\/+$/, "");
  const links: TrackedLink[] = [];

  const rewritten = text.replace(URL_PATTERN, (match) => {
    const url = trimUrl(match);
    const trailer = match.slice(url.length);
    if (EMPTY_URL.test(url) || url.startsWith(`${base}/l/`)) return match;

    const slug = makeSlug();
    links.push({ slug, targetUrl: url });
    return `${base}/l/${slug}${trailer}`;
  });

  return { text: rewritten, links };
}
