import "server-only";

import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";

/**
 * App identity from the ALB Cognito front door.
 *
 * The app is ONLY reachable through the ALB, whose HTTPS:443 listener default
 * action is `authenticate-cognito` (Google Workspace SAML). On every
 * authenticated request the ALB injects `x-amzn-oidc-data` — a JWS (ES256)
 * whose payload carries the Cognito claims (email, name, `cognito:groups`).
 *
 * We VERIFY that token's signature before trusting any claim. AWS signs it with
 * an EC key whose public half is published (PEM) at
 * `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`, where `<kid>` and
 * the signing ALB's ARN (`signer`) live in the JWS protected header. We fetch
 * the key for the token's `kid`, verify the ES256 signature (and `exp`), and
 * assert `signer` matches our own ALB ARN — so a forged or replayed header
 * cannot spoof `email`/`cognito:groups` even if a request reaches the container
 * off the ALB path.
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

/** Imported (verified) EC public key, keyed by the ALB `kid`. */
type PublicKey = Awaited<ReturnType<typeof importSPKI>>;
const keyCache = new Map<string, PublicKey>();

/** The AWS region whose ALB public-key endpoint to query. */
function albRegion(): string {
  return process.env.ALB_REGION || process.env.AWS_REGION || "us-east-1";
}

/**
 * Fetch + import (once, then cache) the EC public key AWS published for `kid`,
 * from `https://public-keys.auth.elb.<region>.amazonaws.com/<kid>`.
 */
async function albPublicKey(kid: string): Promise<PublicKey> {
  const cached = keyCache.get(kid);
  if (cached) return cached;

  const url = `https://public-keys.auth.elb.${albRegion()}.amazonaws.com/${kid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ALB public key fetch failed for kid ${kid}: ${res.status}`);
  }
  const pem = await res.text();
  const key = await importSPKI(pem, "ES256");
  keyCache.set(kid, key);
  return key;
}

/**
 * Resolve the current user from the ALB `x-amzn-oidc-data` header, VERIFYING the
 * ES256 signature (and `exp`) and asserting the token's `signer` is our ALB
 * before trusting any claim.
 *
 * Returns null when the header is absent (local/dev, or the login fallback),
 * malformed, fails verification, is signed by an unexpected ALB, or carries no
 * email — all treated as "not authenticated" (never a 500).
 *
 * THROWS only for a fail-loud misconfiguration: a token is present but `ALB_ARN`
 * (the expected signer) is not configured, so we cannot know which ALB to trust.
 */
export async function getUser(headers: HeaderSource): Promise<AppUser | null> {
  // --- TEMPORARY internal-preview shim (default OFF) --------------------------
  // For the no-SAML private deployment (the `previewMode` infra: an INTERNAL
  // HTTP:80 ALB with NO authenticate-cognito), no `x-amzn-oidc-data` token ever
  // arrives, so real verification could never succeed. When PREVIEW_AUTH is a
  // non-empty string, short-circuit to a stub user in that group WITHOUT reading
  // or verifying any token and WITHOUT requiring ALB_ARN. When PREVIEW_AUTH is
  // unset/empty, this branch is skipped and behaviour is unchanged (real ES256
  // jwtVerify + signer/exp checks, fail-loud on a token with ALB_ARN unset).
  // Remove this shim once the Cognito front door is the only deployment path.
  const previewGroup = process.env.PREVIEW_AUTH;
  if (previewGroup) {
    return {
      email: "preview@nsightcare.com",
      name: "Preview User",
      groups: [previewGroup],
    };
  }
  // ----------------------------------------------------------------------------

  const raw = readHeader(headers, OIDC_DATA_HEADER);
  if (!raw) return null;

  const expectedSigner = process.env.ALB_ARN;
  if (!expectedSigner) {
    throw new Error(
      "ALB_ARN is not configured: refusing to trust an unverified " +
        "x-amzn-oidc-data token. Set ALB_ARN to the front-door ALB ARN.",
    );
  }

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(raw).kid;
  } catch {
    return null; // not a well-formed JWS
  }
  if (!kid) return null;

  let claims: Record<string, unknown>;
  try {
    const key = await albPublicKey(kid);
    const { payload, protectedHeader } = await jwtVerify(raw, key, {
      algorithms: ["ES256"],
    });
    if (protectedHeader.signer !== expectedSigner) return null;
    claims = payload as Record<string, unknown>;
  } catch {
    return null; // bad signature, expired, unknown key, fetch failure, etc.
  }

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
export async function requireUser(
  headers: HeaderSource,
  group?: string,
): Promise<AppUser> {
  const user = await getUser(headers);
  if (!user) throw new AuthError(401, "Not authenticated");
  if (group && !user.groups.includes(group)) {
    throw new AuthError(403, `Requires Cognito group: ${group}`);
  }
  return user;
}
