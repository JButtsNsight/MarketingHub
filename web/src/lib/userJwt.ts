import "server-only";

import { createHash } from "node:crypto";

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { AppUser } from "./auth";

/**
 * Wave-4 user-JWT mint (server-only).
 *
 * Mints short-lived HS256 JWTs — signed with the SAME shared `JWT_SECRET` the
 * self-hosted Supabase stack uses (exposed to the app as SUPABASE_JWT_SECRET) —
 * so PostgREST runs the request under the `authenticated` DB role instead of
 * `service_role`. Identity does NOT come from GoTrue: both session sources
 * (prod ALB/Cognito `x-amzn-oidc-data` and the PREVIEW_AUTH stub) already
 * resolve to an `AppUser` in `lib/auth.ts`; this module maps that AppUser to
 * Supabase-convention claims.
 *
 * Claims (frozen by the Wave-4 contract):
 * - `role`: literal "authenticated" — module-enforced, never overridable.
 * - `sub`: deterministic UUIDv5 of the lowercased email (auth.uid()-castable).
 * - `email`, `groups`, `app_metadata: { groups, source }` where source is
 *   "preview" when PREVIEW_AUTH is set, else "alb-cognito".
 * - `iss: "supabase"`, `aud: "authenticated"` (PostgREST does not enforce aud
 *   at our pin — set for GoTrue-convention compatibility), `iat`, `exp = iat+ttl`.
 *
 * Clock-skew safety: PostgREST validates exp/iat with a 30s skew allowance, so
 * TTLs are floored at MIN_TTL_SECONDS (60s = 2x the skew window) — a minted
 * token can never be dead on arrival — and capped at MAX_TTL_SECONDS (15 min).
 */

/** Default token lifetime (seconds). Frozen by the Wave-4 contract. */
export const DEFAULT_TTL_SECONDS = 300;

/** Hard TTL ceiling (seconds). Frozen by the Wave-4 contract. */
export const MAX_TTL_SECONDS = 900;

/**
 * TTL floor (seconds) — 2x PostgREST's 30s clock-skew allowance, so a token is
 * never expired-on-arrival when the app and DB hosts disagree slightly.
 */
export const MIN_TTL_SECONDS = 60;

/** Where the session identity came from (mirrors `lib/auth.ts` exactly). */
export type UserJwtSource = "alb-cognito" | "preview";

/**
 * RFC 4122 DNS namespace — the fixed UUIDv5 namespace for `sub` derivation.
 * Changing this would change every user's auth.uid(); never touch it.
 */
const SUB_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Fail-loud env read — mirrors `requireEnv` in `lib/supabase.ts`. */
function requireJwtSecret(): string {
  const value = process.env.SUPABASE_JWT_SECRET;
  if (!value) {
    throw new Error(
      "[userJwt] SUPABASE_JWT_SECRET is unset — cannot mint or verify user " +
        "JWTs. (getUserClient() handles the unset case by serving the " +
        "service-role client; only call this module when the flag is set.)",
    );
  }
  return value;
}

function signingKey(): Uint8Array {
  return new TextEncoder().encode(requireJwtSecret());
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/**
 * Deterministic, auth.uid()-castable subject for an email: UUIDv5 (RFC 4122,
 * SHA-1) over the DNS namespace + the LOWERCASED email. Same email (any case)
 * always yields the same `sub`.
 */
export function subForEmail(email: string): string {
  const digest = createHash("sha1")
    .update(uuidToBytes(SUB_NAMESPACE))
    .update(Buffer.from(email.toLowerCase(), "utf8"))
    .digest();

  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/** Validate + normalize a requested TTL. Fail-loud outside [MIN, MAX]. */
function resolveTtlSeconds(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return DEFAULT_TTL_SECONDS;
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
    throw new RangeError(`[userJwt] ttlSeconds must be a finite number, got ${String(ttlSeconds)}`);
  }
  const ttl = Math.floor(ttlSeconds);
  if (ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new RangeError(
      `[userJwt] ttlSeconds must be between ${MIN_TTL_SECONDS} and ` +
        `${MAX_TTL_SECONDS} (got ${ttl}).`,
    );
  }
  return ttl;
}

/**
 * Mint a short-lived HS256 user JWT for PostgREST from an `AppUser` session
 * (either identity source — ALB/Cognito or the PREVIEW_AUTH stub).
 *
 * `role` is ALWAYS the literal "authenticated": the payload is built solely
 * from the fields read here, so extra properties on the argument (including a
 * `role`) can never reach the token. Throws fail-loud when
 * SUPABASE_JWT_SECRET is unset or the TTL is out of range.
 */
export async function mintUserJwt(
  user: AppUser,
  opts?: { ttlSeconds?: number },
): Promise<string> {
  const key = signingKey();
  const ttl = resolveTtlSeconds(opts?.ttlSeconds);

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;

  const groups = [...user.groups];
  const source: UserJwtSource = process.env.PREVIEW_AUTH
    ? "preview"
    : "alb-cognito";

  return await new SignJWT({
    role: "authenticated", // literal — never derived from input
    email: user.email,
    groups,
    app_metadata: { groups, source },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subForEmail(user.email))
    .setIssuer("supabase")
    .setAudience("authenticated")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
}

/**
 * Verify a token minted by `mintUserJwt` and return its claims. Pins
 * `algorithms: ["HS256"]` (blocks alg-confusion) and enforces iss/aud —
 * stricter than PostgREST at our pin, which is fine for our own tokens.
 */
export async function verifyUserJwt(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, signingKey(), {
    algorithms: ["HS256"],
    issuer: "supabase",
    audience: "authenticated",
  });
  return payload;
}
