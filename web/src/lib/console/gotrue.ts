import "server-only";

/**
 * Server-only GoTrue admin READ client — Wave 3-partial foundation.
 *
 * Everything here goes through Kong's always-enabled `auth-v1` route:
 *
 *   GET <SUPABASE_URL>/auth/v1/health
 *   GET <SUPABASE_URL>/auth/v1/settings
 *   GET <SUPABASE_URL>/auth/v1/admin/users[?page&per_page&filter&sort]
 *   GET <SUPABASE_URL>/auth/v1/admin/users/{id}
 *   GET <SUPABASE_URL>/auth/v1/admin/sso/providers
 *   headers: apikey + authorization: Bearer (both — see invariant 2)
 *
 * Load-bearing invariants:
 *
 *   1. GET-ONLY BY DESIGN — hard Wave 3-partial program constraint. Wave 3
 *      Auth is blocked on an external SAML deliverable; this wave ships
 *      read-only console views ONLY. This module must never export a
 *      mutation helper (no create/invite/update/ban/delete users, no SSO
 *      provider writes, no factor changes, no generate_link). Adding one is
 *      a HIGH-severity review finding, not a feature.
 *   2. Every request sends BOTH `apikey: <key>` AND
 *      `authorization: Bearer <key>`. Kong's key-auth needs the apikey
 *      header, and the request-transformer's legacy LUA_AUTH_EXPR falls
 *      back to the RAW apikey with no "Bearer " prefix — which fails
 *      GoTrue's bearer regexp — so the Bearer header must be supplied by
 *      us (established precedent: lib/console/storage.ts render headers).
 *      Never send X-Supabase-Api-Version: it switches GoTrue to the
 *      {code, message} error shape and breaks the parsing below.
 *   3. Callers must already sit behind the console auth gate
 *      (requireMarketingUser on pages, requireUser on routes) — admin user
 *      listings carry emails/phones and auth metadata.
 *   4. Honest degradation: missing env, network failures, timeouts, and the
 *      gateway statuses that mean "GoTrue is not answering" (502/503/504)
 *      throw GoTrueUnavailableError so pages can render the "GoTrue
 *      unreachable" Surface. UNLIKE the W6 analytics route, /auth/v1/ is
 *      always enabled in the pinned kong.yml, so 401/403/404 under it are
 *      real API answers, never route-missing: 401/403 mean the key is
 *      misconfigured (actionable failure, NOT unavailable — 403 not_admin
 *      gets a dedicated message) and 404 is GoTrue answering
 *      "no such user/provider". Everything else throws plain
 *      `[console:gotrue] <op> failed: <msg>` errors, which consoleAttempt
 *      maps to 400s.
 *   5. The service key never appears in error messages, and neither does the
 *      SUPABASE_URL value (a malformed value is refused with a static detail
 *      BEFORE fetch, because Node's URL-parse TypeError echoes its input and
 *      unavailable details travel to console clients in 503 bodies) — errors
 *      only ever carry upstream response text and our own detail strings.
 */

/** Kong upstream timeout is 60s; stay under it so errors are ours, not 504s. */
const GOTRUE_TIMEOUT_MS = 30_000;

/**
 * GoTrue cannot be reached at all (env not configured, network failure,
 * timeout, or Kong answering that the upstream is down/wedged/slow). Pages
 * catch THIS class to render the honest "GoTrue unreachable" state;
 * anything else is a real error.
 */
export class GoTrueUnavailableError extends Error {
  constructor(detail: string) {
    super(`[console:gotrue] gotrue unreachable: ${detail}`);
    this.name = "GoTrueUnavailableError";
  }
}

function fail(op: string, message: string): never {
  throw new Error(`[console:gotrue] ${op} failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Types — field sets verified against supabase/auth v2.186.0 (the exact
// pinned image). Extra upstream fields ride along untyped.
// ---------------------------------------------------------------------------

export interface Identity {
  /** Row UUID of the identity record. */
  identity_id: string;
  /** Provider-scoped id (GoTrue's provider_id). */
  id: string;
  provider: string;
  created_at: string;
  last_sign_in_at: string;
}

export interface Factor {
  id: string;
  /** "totp" | "phone" | "webauthn" at the pin. */
  factor_type: string;
  /** "verified" | "unverified" at the pin. */
  status: string;
  friendly_name?: string;
  created_at: string;
}

export interface GoTrueUser {
  id: string;
  aud: string;
  role: string;
  email?: string;
  phone?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  /**
   * ALWAYS null on listUsers rows (the list endpoint does not eager-load);
   * populated only by getUser. Never render identities from list data.
   */
  identities: Identity[] | null;
  created_at: string;
  last_sign_in_at?: string;
  banned_until?: string;
  email_confirmed_at?: string;
  /**
   * Absent on listUsers rows AND on zero-factor getUser answers (upstream
   * tags the field `omitempty`, which drops empty lists too, so a present
   * `factors: []` never occurs); non-empty only via getUser.
   */
  factors?: Factor[];
  is_anonymous: boolean;
}

export interface SsoProvider {
  id: string;
  resource_id?: string;
  disabled: boolean;
  /** Only type "saml" exists at the pin; metadata_xml is blanked in lists. */
  saml: { entity_id: string; metadata_url?: string };
  domains: Array<{ domain: string }>;
  created_at: string;
}

export interface GoTrueSettings {
  /** Provider slug → enabled flag (the 26 external flags at the pin). */
  external: Record<string, boolean>;
  disable_signup: boolean;
  mailer_autoconfirm: boolean;
  phone_autoconfirm: boolean;
  sms_provider: string;
  saml_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Statuses that mean "GoTrue is not answering", not "your request failed".
 * The auth-v1 Kong route is always enabled, so — unlike W6 analytics —
 * 401/403/404 here are REAL answers (key misconfig / not found) and only
 * the gateway's upstream-down statuses count as unreachable.
 */
const UNAVAILABLE_STATUS: Record<number, string> = {
  502: "502 — Kong could not reach the GoTrue container",
  503: "503 — GoTrue is unavailable behind Kong",
  504: "504 — GoTrue timed out behind Kong",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Best-effort message for a non-OK upstream answer. Distinguishes GoTrue's
 * {code, error_code, msg} shape from Kong's own {message} shape (key-auth /
 * ACL rejections), and turns 403 not_admin into the actionable truth: the
 * configured key passed Kong but GoTrue says its role claim is not an admin
 * role — a key misconfiguration, never an outage. The key itself is never
 * echoed here.
 */
function upstreamMessage(status: number, body: unknown, text: string): string {
  const record = asRecord(body);
  if (record && typeof record.msg === "string") {
    const errorCode =
      typeof record.error_code === "string" ? record.error_code : "";
    if (status === 403 && errorCode === "not_admin") {
      return (
        "403 not_admin — GoTrue accepted the JWT but its role claim is not " +
        "an admin role: SUPABASE_SERVICE_ROLE_KEY on this server is not the " +
        "service-role key (it must carry role=service_role)"
      );
    }
    return errorCode
      ? `${status} ${errorCode}: ${record.msg}`
      : `${status}: ${record.msg}`;
  }
  if (record && typeof record.message === "string") {
    // Kong's own error shape — key-auth/ACL failure before GoTrue was
    // reached (e.g. "No API key found in request").
    return `${status} (kong): ${record.message}`;
  }
  return `${status}: ${text.slice(0, 300)}`;
}

/**
 * One GET under <SUPABASE_URL>/auth/v1. Unreachable states (missing env,
 * network, timeout, 502/503/504) throw GoTrueUnavailableError; every other
 * non-OK answer throws a plain [console:gotrue] error via upstreamMessage.
 * `query` is a pre-encoded query string (no leading "?").
 */
async function gotrueGet(
  op: string,
  path: string,
  query?: string,
): Promise<{ body: unknown; headers: Headers }> {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new GoTrueUnavailableError(
      "SUPABASE_URL is not configured on this server",
    );
  }
  // Refuse a malformed base HERE, with a STATIC detail — invariant 5. If a
  // bad value (stray space/bracket from a task-def edit) reached fetch(),
  // Node's URL-parse TypeError would echo the full internal URL into the
  // error message, and the routes forward unavailable details to clients in
  // 503 bodies. Real network failures are unaffected: undici keeps those at
  // "fetch failed" (the detail lives on err.cause, which we never surface).
  const parsedBase = URL.canParse(base) ? new URL(base) : null;
  if (
    !parsedBase ||
    (parsedBase.protocol !== "http:" && parsedBase.protocol !== "https:")
  ) {
    throw new GoTrueUnavailableError(
      "SUPABASE_URL is not a valid http(s) URL on this server",
    );
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new GoTrueUnavailableError(
      "SUPABASE_SERVICE_ROLE_KEY is not configured on this server",
    );
  }

  const url = `${base}/auth/v1${path}${query ? `?${query}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOTRUE_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      // Both headers — invariant 2. Never X-Supabase-Api-Version.
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    // The body read stays INSIDE the abort-guarded try: the 30s bound must
    // cover a stalled/trickling body, not just the header phase (undici's
    // default bodyTimeout is ~300s, far past Kong's 60s), and a connection
    // dropped mid-stream (undici TypeError "terminated") is GoTrue not
    // answering — GoTrueUnavailableError, never an unhandled route 500.
    text = await res.text();
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${GOTRUE_TIMEOUT_MS} ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new GoTrueUnavailableError(detail);
  } finally {
    clearTimeout(timer);
  }

  if (UNAVAILABLE_STATUS[res.status]) {
    throw new GoTrueUnavailableError(
      `Kong returned ${UNAVAILABLE_STATUS[res.status]}`,
    );
  }

  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    fail(op, `unparseable response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    fail(op, upstreamMessage(res.status, body, text));
  }
  return { body, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

/**
 * GET /health — reachability probe + running version for the console chip.
 * Needs no GoTrue auth but IS behind Kong key-auth, so the apikey header
 * still travels (gotrueGet always sends it).
 */
export async function gotrueHealth(): Promise<{
  version: string;
  name: string;
}> {
  const op = "health";
  const { body } = await gotrueGet(op, "/health");
  const record = asRecord(body);
  if (
    !record ||
    typeof record.version !== "string" ||
    typeof record.name !== "string"
  ) {
    fail(op, "unexpected response shape: missing version/name");
  }
  return { version: record.version, name: record.name };
}

/** Clamp an optional integer into [1, max]; undefined → fallback. */
function clampPositiveInt(
  op: string,
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(op, `${name} must be a finite number`);
  }
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/** Cap on the server-side substring filter; longer input is truncated. */
const FILTER_MAX_CHARS = 200;

const SORT_DIRECTIONS = ["asc", "desc"] as const;

export interface ListUsersOptions {
  /** 1-based page; default 1. */
  page?: number;
  /** Rows per page; default 50, clamped to [1, 100]. */
  perPage?: number;
  /**
   * Server-side substring match on email / user_metadata full_name — the
   * ONLY search GoTrue supports at the pin (no exact-email/phone params).
   * Blank/whitespace is omitted from the request.
   */
  filter?: string;
  /** created_at direction — the only sortable field at the pin. Default desc. */
  sort?: "asc" | "desc";
}

/**
 * GET /admin/users. Total comes from the X-Total-Count response header.
 * List rows are NOT eager-loaded: identities is null and factors is absent
 * on every row — renderers must use getUser for those.
 */
export async function listUsers(
  opts: ListUsersOptions = {},
): Promise<{ users: GoTrueUser[]; total: number }> {
  const op = "list-users";
  const page = clampPositiveInt(op, "page", opts.page, 1, 1_000_000);
  const perPage = clampPositiveInt(op, "perPage", opts.perPage, 50, 100);
  const sort = opts.sort ?? "desc";
  if (!SORT_DIRECTIONS.includes(sort)) {
    fail(op, `sort must be one of ${SORT_DIRECTIONS.join(", ")}`);
  }

  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  const filter = opts.filter?.trim().slice(0, FILTER_MAX_CHARS) ?? "";
  if (filter !== "") params.set("filter", filter);
  params.set("sort", `created_at ${sort}`);
  // URLSearchParams encodes spaces as "+"; GoTrue decodes either form, but
  // the canonical wire shape is sort=created_at%20<dir>. Any "+" left after
  // toString() IS an encoded space (a literal "+" became %2B), so this
  // rewrite is lossless.
  const query = params.toString().replace(/\+/g, "%20");

  const { body, headers } = await gotrueGet(op, "/admin/users", query);
  const record = asRecord(body);
  if (!record || !Array.isArray(record.users)) {
    fail(op, "unexpected response shape: missing users array");
  }
  const users = record.users as GoTrueUser[];
  const totalHeader = headers.get("x-total-count");
  const total =
    totalHeader !== null && /^\d+$/.test(totalHeader)
      ? Number(totalHeader)
      : users.length;
  return { users, total };
}

/**
 * GET /admin/users/{id} — the eager-loaded single user (identities
 * populated; factors present only when any are enrolled — upstream
 * `omitempty` drops the key for zero-factor users). A 404 here is GoTrue's
 * real answer (user_not_found, or validation_failed for non-UUID ids),
 * surfaced as a plain failure.
 */
export async function getUser(id: string): Promise<GoTrueUser> {
  const op = "get-user";
  const trimmed = typeof id === "string" ? id.trim() : "";
  if (trimmed === "") fail(op, "id is required");
  const { body } = await gotrueGet(
    op,
    `/admin/users/${encodeURIComponent(trimmed)}`,
  );
  const record = asRecord(body);
  if (!record || typeof record.id !== "string") {
    fail(op, "unexpected response shape: missing user id");
  }
  return record as unknown as GoTrueUser;
}

/**
 * GET /admin/sso/providers — unwraps {items}; GoTrue answers items:[] or
 * null via its no-rows path, both of which normalize to []. No pagination
 * exists at the pin.
 */
export async function listSsoProviders(): Promise<SsoProvider[]> {
  const op = "list-sso-providers";
  const { body } = await gotrueGet(op, "/admin/sso/providers");
  const record = asRecord(body);
  if (!record) {
    fail(op, "unexpected response shape: expected an items object");
  }
  if (record.items == null) return [];
  if (!Array.isArray(record.items)) {
    fail(op, "unexpected response shape: items is not an array");
  }
  return record.items as SsoProvider[];
}

/**
 * GET /settings — the public instance-configuration snapshot (external
 * provider flags, signup/autoconfirm posture, sms provider, saml_enabled).
 * No GoTrue auth needed, but Kong key-auth still applies.
 */
export async function getSettings(): Promise<GoTrueSettings> {
  const op = "get-settings";
  const { body } = await gotrueGet(op, "/settings");
  const record = asRecord(body);
  const external = record ? asRecord(record.external) : undefined;
  if (!record || !external) {
    fail(op, "unexpected response shape: missing external provider flags");
  }
  const flags: Record<string, boolean> = {};
  for (const [provider, enabled] of Object.entries(external)) {
    flags[provider] = enabled === true;
  }
  return {
    external: flags,
    disable_signup: record.disable_signup === true,
    mailer_autoconfirm: record.mailer_autoconfirm === true,
    phone_autoconfirm: record.phone_autoconfirm === true,
    sms_provider:
      typeof record.sms_provider === "string" ? record.sms_provider : "",
    saml_enabled: record.saml_enabled === true,
  };
}
