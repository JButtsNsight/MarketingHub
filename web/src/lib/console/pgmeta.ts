import "server-only";

/**
 * Server-only postgres-meta client — the same service Supabase Studio itself
 * is built on, reached through Kong at `<SUPABASE_URL>/pg/*`. Kong's key-auth
 * admits only the service-role key, and pg-meta then runs everything over its
 * OWN Postgres connection as `supabase_admin` — i.e. every call here is
 * effectively superuser. Two consequences, both load-bearing:
 *
 *   1. This module is `server-only` and must only ever be reached through
 *      routes/pages that have ALREADY passed the Cognito `marketing` group
 *      gate (same contract as getServiceClient()).
 *   2. Callers exposing /query to a UI own the guard layer (statement
 *      classification, confirms, row caps) — nothing here will save them.
 *
 * Verified against the self-hosted backend 2026-08-06: GET /pg/tables and
 * POST /pg/query both work through Kong with the service-role key.
 */

/** Kong upstream timeout is 60s; stay under it so errors are ours, not 504s. */
const PGMETA_TIMEOUT_MS = 30_000;

/** Fail-loud env read — never fall back to a default or silently no-op. */
function requireEnv(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[console:pgmeta] Missing required server env ${name}. ` +
        `postgres-meta cannot be reached without it.`,
    );
  }
  return value;
}

function fail(op: string, message: string): never {
  throw new Error(`[console:pgmeta] ${op} failed: ${message}`);
}

/**
 * One pg-meta request. Non-2xx responses surface pg-meta's own error message
 * (it reports SQL errors as JSON) so the SQL editor can show real Postgres
 * errors verbatim — that IS the Studio behavior.
 */
async function pgMetaFetch<T>(
  op: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PGMETA_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/pg${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${PGMETA_TIMEOUT_MS} ms`
        : err instanceof Error
          ? err.message
          : String(err);
    fail(op, detail);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    fail(op, `${res.status}: ${extractError(text)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    fail(op, `unparseable response: ${text.slice(0, 200)}`);
  }
}

/** Best-effort error message from a pg-meta error body (shapes vary). */
function extractError(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // fall through to the raw text
  }
  return text.slice(0, 500) || "(empty error body)";
}

// ---------------------------------------------------------------------------
// Shapes — the pg-meta fields the console consumes (responses carry more).
// ---------------------------------------------------------------------------

export interface PgPrimaryKey {
  schema: string;
  table_name: string;
  name: string;
}

export interface PgRelationship {
  constraint_name: string;
  source_schema: string;
  source_table_name: string;
  source_column_name: string;
  target_table_schema: string;
  target_table_name: string;
  target_column_name: string;
}

export interface PgTable {
  id: number;
  schema: string;
  name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  live_rows_estimate: number;
  bytes: number;
  size: string;
  comment: string | null;
  primary_keys: PgPrimaryKey[];
  relationships: PgRelationship[];
}

export interface PgColumn {
  id: string;
  table_id: number;
  schema: string;
  table: string;
  name: string;
  ordinal_position: number;
  /** Postgres data type ("text", "timestamp with time zone", "USER-DEFINED"…). */
  data_type: string;
  /** PostgREST format name ("text", "timestamptz", "uuid", enum name…). */
  format: string;
  is_nullable: boolean;
  is_identity: boolean;
  is_generated: boolean;
  is_updatable: boolean;
  default_value: string | null;
  /** Allowed values when the column is an enum; [] otherwise. */
  enums: string[];
  comment: string | null;
}

export interface PgPolicy {
  id: number;
  schema: string;
  table: string;
  name: string;
  /** PERMISSIVE | RESTRICTIVE */
  action: string;
  roles: string[];
  /** ALL | SELECT | INSERT | UPDATE | DELETE */
  command: string;
  definition: string | null;
  check: string | null;
}

export interface PgExtension {
  name: string;
  schema: string | null;
  default_version: string;
  installed_version: string | null;
  comment: string | null;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Live tables for the given schemas (metadata only, no column payload). */
export async function listTables(schemas: string[]): Promise<PgTable[]> {
  const qs = encodeURIComponent(schemas.join(","));
  return pgMetaFetch<PgTable[]>(
    "list-tables",
    `/tables?included_schemas=${qs}&include_columns=false`,
  );
}

/** Live columns for the given schemas. */
export async function listColumns(schemas: string[]): Promise<PgColumn[]> {
  const qs = encodeURIComponent(schemas.join(","));
  return pgMetaFetch<PgColumn[]>(
    "list-columns",
    `/columns?included_schemas=${qs}`,
  );
}

/** Live RLS policies for the given schemas. */
export async function listPolicies(schemas: string[]): Promise<PgPolicy[]> {
  const qs = encodeURIComponent(schemas.join(","));
  return pgMetaFetch<PgPolicy[]>(
    "list-policies",
    `/policies?included_schemas=${qs}`,
  );
}

/** Installed + available extensions. */
export async function listExtensions(): Promise<PgExtension[]> {
  return pgMetaFetch<PgExtension[]>("list-extensions", "/extensions");
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/** A /query result: SELECTs return row objects; DML/DDL return []. */
export type QueryRows = Array<Record<string, unknown>>;

/**
 * Execute SQL as `supabase_admin` via pg-meta. Postgres errors come back as
 * thrown [console:pgmeta] errors carrying the real message (callers surface
 * them verbatim in the editor — that is the Studio behavior). NO guard layer
 * here by design: the API route owns classification/confirm/row caps.
 */
export async function runQuery(sql: string): Promise<QueryRows> {
  return pgMetaFetch<QueryRows>("query", "/query", {
    method: "POST",
    body: JSON.stringify({ query: sql }),
  });
}
