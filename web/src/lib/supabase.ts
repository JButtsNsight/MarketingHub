import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase access.
 *
 * This module talks to the self-hosted MarketingHub Supabase backend with the
 * `service_role` key over PostgREST + the Storage API. It is imported ONLY from
 * Route Handlers / server components / other server-only modules — never from a
 * client component, and never shipped in the browser bundle. Cognito (via the
 * ALB) remains the sole auth authority; the service-role key bypasses RLS, so
 * app-layer authz (group gate) must have already run before this is used.
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
