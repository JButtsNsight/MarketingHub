import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { AppUser } from "./auth";
import { mintUserJwt } from "./userJwt";

/**
 * Server-only Supabase access.
 *
 * This module talks to the self-hosted MarketingHub Supabase backend with the
 * `service_role` key over PostgREST + the Storage API. It is imported ONLY from
 * Route Handlers / server components / other server-only modules — never from a
 * client component, and never shipped in the browser bundle. Cognito (via the
 * ALB) remains the sole auth authority; the service-role key bypasses RLS, so
 * app-layer authz (group gate) must have already run before this is used.
 *
 * Wave 4 adds `getUserClient(user)`: when SUPABASE_JWT_SECRET is set, it mints
 * a short-lived per-user HS256 JWT (see `lib/userJwt.ts`) so PostgREST runs the
 * request as the `authenticated` role under RLS. When the flag is unset, it
 * returns `getServiceClient()` — byte-identical to pre-Wave-4 behaviour.
 */

let cached: SupabaseClient | null = null;

/** Fail-loud env read — never fall back to a default or silently no-op. */
function requireEnv(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[marketinghub] Missing required server env ${name}. ` +
        `The Supabase service connection cannot be created without it.`,
    );
  }
  return value;
}

/**
 * Returns a memoized service-role Supabase client. Throws (fail-loud) if either
 * SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset.
 */
export function getServiceClient(): SupabaseClient {
  if (cached) return cached;

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cached;
}

/** Warn-once guard for the SUPABASE_JWT_SECRET-unset fallback path. */
let warnedJwtSecretUnset = false;

/**
 * Returns a Supabase client scoped to `user` via a short-lived HS256 JWT.
 *
 * Flag: `SUPABASE_JWT_SECRET` presence is the ONLY switch.
 * - Unset ⇒ returns the memoized `getServiceClient()` (byte-identical to the
 *   pre-Wave-4 service-role path) and `console.warn`s ONCE per process.
 * - Set ⇒ builds a NEW client per call (never memoized — the embedded JWT is
 *   per-user and short-lived). The service-role key stays as the `apikey`
 *   header (Kong key-auth needs a known key); the `Authorization` header
 *   carries the minted user JWT, which is what PostgREST derives the DB role
 *   from — so requests run as `authenticated` under RLS.
 */
export async function getUserClient(user: AppUser): Promise<SupabaseClient> {
  if (!process.env.SUPABASE_JWT_SECRET) {
    if (!warnedJwtSecretUnset) {
      warnedJwtSecretUnset = true;
      console.warn(
        "[supabase] SUPABASE_JWT_SECRET unset — getUserClient() serving service-role client",
      );
    }
    return getServiceClient();
  }

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const token = await mintUserJwt(user);

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}
