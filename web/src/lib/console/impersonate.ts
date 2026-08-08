import "server-only";

import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { JWTPayload } from "jose";

import type { AppUser } from "../auth";
import { getServiceClient } from "../supabase";
import { mintUserJwt, verifyUserJwt } from "../userJwt";

/**
 * User Impersonation data layer (Studio's "what can this identity see" panel).
 *
 * Mints a bounded user JWT (role `authenticated` ONLY — enforced by
 * `mintUserJwt` construction AND re-verified here before anything runs; exp is
 * capped at 15 minutes by `userJwt`'s MAX_TTL_SECONDS), executes the requested
 * PostgREST select server-side as that identity, and runs the SAME select as
 * `service_role` so the console can show both result sets side by side.
 *
 * Security invariants:
 * - The raw JWT NEVER leaves the server. `returnToken` yields only a SHA-256
 *   fingerprint — enough to correlate with logs, useless to replay.
 * - Every mint+query is audited to marketinghub.console_impersonation_audit
 *   via the service client AFTER execution. A failed audit insert is a hard
 *   failure (the route turns ImpersonationAuditError into a 500): this
 *   surface does not return results it could not audit.
 */

const SCHEMA = "marketinghub";
const AUDIT_TABLE = "console_impersonation_audit";

/** Thrown when the mandatory audit insert fails — the route maps this to 500. */
export class ImpersonationAuditError extends Error {
  constructor(message: string) {
    super(`audit insert into ${SCHEMA}.${AUDIT_TABLE} failed: ${message}`);
    this.name = "ImpersonationAuditError";
  }
}

export interface ImpersonationQueryOptions {
  /** Identity to impersonate (any email — sub derives deterministically). */
  email: string;
  /** Cognito-style groups to embed in the token's claims. */
  groups: string[];
  /** Token lifetime in seconds; the route bounds this to [60, 900]. */
  ttlSeconds: number;
  /** Only the app schema is queryable from this surface. */
  schema: "marketinghub";
  /** Bare table name (route-validated against /^[a-z_][a-z0-9_]*$/). */
  table: string;
  /** Row cap for both result sets. */
  limit: number;
  /** When true, include a SHA-256 fingerprint of the token — never the token. */
  returnToken?: boolean;
}

/** One side of the comparison (impersonated user or service_role). */
export interface ImpersonationSideResult {
  rows: Array<Record<string, unknown>>;
  /** Rows returned, or null when the query itself errored. */
  rowCount: number | null;
  error?: string;
}

export interface ImpersonationResult {
  /** The minted token's verified claims (role is always "authenticated"). */
  claims: JWTPayload;
  /** The impersonated identity's result set. */
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  error?: string;
  /** The same select run as service_role (RLS-bypassing baseline). */
  serviceRole: ImpersonationSideResult;
  /** SHA-256 fingerprint of the minted JWT ("sha256:<hex>") — NEVER the JWT. */
  token?: string;
}

/** Fail-loud env read — mirrors `requireEnv` in `lib/supabase.ts`. */
function requireEnv(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[console:impersonate] Missing required server env ${name}. ` +
        `The impersonated Supabase connection cannot be created without it.`,
    );
  }
  return value;
}

/**
 * One-off client carrying the minted JWT (contract §2 shape): the service key
 * stays as the `apikey` (Kong key-auth needs a known key); PostgREST derives
 * the `authenticated` role from the Authorization header. Never memoized —
 * the embedded token is per-request and short-lived.
 */
function oneOffUserClient(token: string): SupabaseClient {
  return createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    },
  );
}

/**
 * Run the comparison select on one client. PostgREST errors (RLS denials,
 * missing grants, unknown tables) are the panel's normal feedback — they come
 * back as `error`, never as a thrown exception, so the audit always runs.
 */
async function runSelect(
  client: SupabaseClient,
  schema: string,
  table: string,
  limit: number,
): Promise<ImpersonationSideResult> {
  try {
    const { data, error } = await client
      .schema(schema)
      .from(table)
      .select("*")
      .limit(limit);
    if (error) return { rows: [], rowCount: null, error: error.message };
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    return { rows, rowCount: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rows: [], rowCount: null, error: message };
  }
}

/**
 * Mint a bounded impersonation token for `opts.email`, run the select as that
 * identity AND as service_role, audit the run, and return both result sets
 * plus the token's claims.
 *
 * Throws:
 * - Error mentioning SUPABASE_JWT_SECRET when the Wave-4 flag is unset
 *   (nothing minted, nothing run, nothing to audit).
 * - Error when the minted claims' role is not "authenticated" (cannot happen
 *   through `mintUserJwt`, but this surface re-checks — defense in depth).
 * - ImpersonationAuditError when the audit insert fails (route ⇒ 500).
 */
export async function runImpersonatedQuery(
  actorEmail: string,
  opts: ImpersonationQueryOptions,
): Promise<ImpersonationResult> {
  // Only email/groups reach the mint; `name` is not a token claim. `role` is
  // the module-enforced literal "authenticated" — nothing in `opts` can
  // change it.
  const target: AppUser = {
    email: opts.email,
    name: opts.email,
    groups: [...opts.groups],
  };
  const token = await mintUserJwt(target, { ttlSeconds: opts.ttlSeconds });

  // Verify our own mint and clamp the role server-side: anything other than
  // the literal "authenticated" refuses to execute.
  const claims = await verifyUserJwt(token);
  if (claims.role !== "authenticated") {
    throw new Error(
      `[console:impersonate] refusing to run: minted role ${JSON.stringify(
        claims.role,
      )} is not "authenticated"`,
    );
  }

  const asUser = await runSelect(
    oneOffUserClient(token),
    opts.schema,
    opts.table,
    opts.limit,
  );
  const asServiceRole = await runSelect(
    getServiceClient(),
    opts.schema,
    opts.table,
    opts.limit,
  );

  // Audit AFTER execution, via the service client (the audit table is
  // service-only — deny_all keeps `authenticated` out). Failure is loud AND
  // fatal: results never leave without an audit row.
  const { error: auditError } = await getServiceClient()
    .schema(SCHEMA)
    .from(AUDIT_TABLE)
    .insert({
      actor_email: actorEmail,
      claims: claims as Record<string, unknown>,
      target_schema: opts.schema,
      target_table: opts.table,
      row_count: asUser.rowCount,
      success: asUser.error === undefined,
      error: asUser.error ?? null,
    });
  if (auditError) {
    console.error(
      `[console:impersonate] audit insert failed (actor ${actorEmail}, ` +
        `target ${opts.schema}.${opts.table}): ${auditError.message}`,
    );
    throw new ImpersonationAuditError(auditError.message);
  }

  return {
    claims,
    rows: asUser.rows,
    rowCount: asUser.rowCount,
    error: asUser.error,
    serviceRole: asServiceRole,
    ...(opts.returnToken
      ? { token: `sha256:${createHash("sha256").update(token).digest("hex")}` }
      : {}),
  };
}
