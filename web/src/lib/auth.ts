import "server-only";

/**
 * App identity from the ALB Cognito front door.
 *
 * The app is ONLY reachable through the ALB, whose HTTPS:443 listener default
 * action is `authenticate-cognito` (Google Workspace SAML). On every
 * authenticated request the ALB injects `x-amzn-oidc-data` — a signed JWT whose
 * payload carries the Cognito claims (email, name, `cognito:groups`).
 *
 * For v1 we TRUST that header rather than verifying the ALB signature: the only
 * network path to the app is through the ALB (the Fargate service SG accepts the
 * container port from the ALB SG alone), so an unsigned/forged header cannot
 * reach the app from outside. Signature verification via the ALB public-key
 * endpoint is a documented hardening follow-up.
 *
 * This module is server-only (imported from Route Handlers / server components).
 * The group gate (`requireUser`) is therefore enforced SERVER-SIDE — the browser
 * never decides authz.
 */

const OIDC_DATA_HEADER = "x-amzn-oidc-data";

export interface AppUser {
  email: string;
  name: string;
  groups: string[];
}

/** The structural shape of a Fetch `Headers` / Next `ReadonlyHeaders`. */
export interface HeadersGetter {
  get(name: string): string | null;
}

/** Anything header-like: a `Headers`/`ReadonlyHeaders`, or a plain record. */
export type HeaderSource =
  | HeadersGetter
  | Record<string, string | string[] | undefined>;

/** Thrown by `requireUser`; `status` maps to the HTTP response a caller returns. */
export class AuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as HeadersGetter).get === "function") {
    return (headers as HeadersGetter).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  // Node lower-cases header keys; check the canonical name first, then any case.
  const direct = record[name] ?? record[name.toLowerCase()];
  const value =
    direct ??
    Object.entries(record).find(([k]) => k.toLowerCase() === name)?.[1];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** base64url-decode a JWT segment to its JSON object, or null if it is not valid. */
function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Normalize the `cognito:groups` claim (array OR serialized string) to string[]. */
function parseGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) {
    return claim.map((g) => String(g).trim()).filter(Boolean);
  }
  if (typeof claim === "string") {
    // ALB may serialize as "[a b c]" or "a,b,c"; split on brackets/commas/space.
    return claim
      .replace(/^\[|\]$/g, "")
      .split(/[\s,]+/)
      .map((g) => g.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Decode the current user from the ALB OIDC-data header. Returns null when the
 * header is absent, malformed, or carries no email (i.e. not authenticated).
 */
export function getUser(headers: HeaderSource): AppUser | null {
  const raw = readHeader(headers, OIDC_DATA_HEADER);
  if (!raw) return null;

  const parts = raw.split(".");
  if (parts.length < 2) return null;

  const claims = decodeSegment(parts[1]);
  if (!claims) return null;

  const email = typeof claims.email === "string" ? claims.email : null;
  if (!email) return null;

  const name =
    (typeof claims.name === "string" && claims.name) ||
    (typeof claims.given_name === "string" && claims.given_name) ||
    email;

  return { email, name, groups: parseGroups(claims["cognito:groups"]) };
}

/**
 * Server-side auth gate. Returns the authenticated user, or throws an
 * `AuthError` (401 if unauthenticated, 403 if the required Cognito group is
 * missing). Callers map the status to their HTTP response.
 */
export function requireUser(headers: HeaderSource, group?: string): AppUser {
  const user = getUser(headers);
  if (!user) throw new AuthError(401, "Not authenticated");
  if (group && !user.groups.includes(group)) {
    throw new AuthError(403, `Requires Cognito group: ${group}`);
  }
  return user;
}
