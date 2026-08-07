import "server-only";

/**
 * SQL-safety primitives shared by the console's object/advisor/cron/queue data
 * layers. Every one of those modules ultimately runs SQL through
 * `runQuery(sql)` as `supabase_admin` (SUPERUSER), and `runQuery` has NO bind
 * parameters — the SQL is a single string. So anything user-supplied that ends
 * up in a statement MUST pass through here first:
 *
 *   - identifiers  → `assertValidIdentifier` / `quoteIdent` (regex-gated, then
 *     wrapped like Postgres `quote_ident`), and the CALLER additionally
 *     existence-checks the name against live introspection before building DDL
 *     (mirrors how tables.ts validates schema/table/column before PostgREST).
 *   - values       → `quoteLiteral` (Postgres `quote_literal` semantics), so a
 *     value is a literal Postgres never re-parses as SQL.
 *   - integers     → `assertSafeInteger` (job ids, message ids, limits).
 *
 * These functions are intentionally dependency-free (no `runQuery` import) so
 * they are trivially unit-testable and can never themselves reach the DB.
 */

/**
 * A Postgres unquoted identifier: a letter or underscore, then letters, digits
 * or underscores. NAMEDATALEN caps a name at 63 bytes. This is deliberately
 * STRICTER than what Postgres would accept quoted — it is our allow-list for
 * anything we splice into DDL, so `"weird name"`, embedded quotes, and dotted
 * qualifiers are all rejected and must be passed as separate parts.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Max identifier length Postgres stores (NAMEDATALEN - 1). */
export const MAX_IDENTIFIER_LEN = 63;

export function isValidIdentifier(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_IDENTIFIER_LEN &&
    IDENTIFIER_RE.test(name)
  );
}

/**
 * Assert `name` is a safe identifier or throw a plain Error. Callers that want
 * the `[console:<area>]` convention should check `isValidIdentifier` and route
 * through their own `fail(op, ...)`; this is the low-level guard.
 */
export function assertValidIdentifier(name: unknown, label = "identifier"): string {
  if (!isValidIdentifier(name)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Postgres `quote_ident` for the strict subset we allow: validate, then wrap in
 * double quotes (doubling any embedded quote defensively — the validator forbids
 * them today, but keep the semantics correct if the guard ever loosens).
 */
export function quoteIdent(name: unknown): string {
  const valid = assertValidIdentifier(name);
  return `"${valid.replace(/"/g, '""')}"`;
}

/**
 * Qualify and quote a `schema.name` pair as one dotted identifier, each part
 * validated independently. Never accept a pre-joined dotted string — that is
 * the injection vector this exists to close.
 */
export function quoteQualified(schema: unknown, name: unknown): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * Postgres `quote_literal` for a string value: double every single quote, and
 * emit an E'' string (escaping backslashes) when the value contains a
 * backslash, so the result is safe regardless of `standard_conforming_strings`.
 * A distinct `null` is written as the SQL keyword `NULL`.
 */
export function quoteLiteral(value: string | null): string {
  if (value === null) return "NULL";
  if (typeof value !== "string") {
    throw new Error(`quoteLiteral expects a string, got ${typeof value}`);
  }
  const escaped = value.replace(/'/g, "''");
  return value.includes("\\")
    ? `E'${escaped.replace(/\\/g, "\\\\")}'`
    : `'${escaped}'`;
}

/**
 * Assert `value` is a safe integer (job ids, message ids, row limits reach SQL
 * unquoted, so they must be provably numeric — never a string spliced in).
 */
export function assertSafeInteger(value: unknown, label = "integer"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Clamp a caller-supplied row limit into `[1, max]`, defaulting when absent.
 * Limits are spliced into `limit N`, so they go through `assertSafeInteger`.
 */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.min(Math.max(1, n), max);
}
