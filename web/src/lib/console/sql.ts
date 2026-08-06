import "server-only";

import { getServiceClient } from "../supabase";
import { runQuery } from "./pgmeta";

/**
 * SQL editor data layer: statement classification (the write-confirm guard),
 * capped execution through pg-meta, and snippet/history persistence.
 *
 * Classification is a GUARD, not a security boundary — the console's owner
 * chose full read-write parity, and pg-meta executes as supabase_admin
 * either way. The guard exists so a write needs an explicit second click,
 * and anything the classifier cannot prove read-only counts as a write
 * (confirm-when-unsure).
 */

const SCHEMA = "marketinghub";
const SNIPPETS = "console_snippets";
const HISTORY = "console_query_history";

/** Result rows returned to the browser are capped (Studio caps similarly). */
export const MAX_RESULT_ROWS = 1_000;
/** History keeps the head of very large statements, not megabytes of SQL. */
const HISTORY_SQL_MAX = 10_000;

function fail(op: string, message: string): never {
  throw new Error(`[console:sql] ${op} failed: ${message}`);
}

function snippets() {
  return getServiceClient().schema(SCHEMA).from(SNIPPETS);
}

function history() {
  return getServiceClient().schema(SCHEMA).from(HISTORY);
}

/** updated_at is app-maintained (no DB trigger) — stamp it on every update. */
function nowIso(): string {
  return new Date().toISOString();
}

export type SqlClassification = "read" | "write";

/**
 * Thrown when a statement classified `read` actually attempts a write once
 * executed inside a read-only transaction (Postgres 25006). This is the
 * backstop that closes classifier blind spots — `EXPLAIN ANALYZE <DML>`
 * (which executes!), `SELECT … INTO`, and side-effectful function calls like
 * `select marketinghub.claim_due_sms_recipients(...)` all trip it. The route
 * turns it into the same confirm handshake a `write` classification gets.
 */
export class ReadOnlyViolationError extends Error {
  constructor() {
    super("statement attempted a write in a read-only transaction");
    this.name = "ReadOnlyViolationError";
  }
}

/** Postgres raises 25006 / this wording when a read-only txn is written to. */
function isReadOnlyViolation(message: string): boolean {
  return /read-only transaction/i.test(message) || /\b25006\b/.test(message);
}

/** Strip line and block comments so keywords are judged, not prose. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * First keyword of every semicolon-separated statement must be provably
 * read-only (SELECT / EXPLAIN / SHOW / TABLE / VALUES, or WITH whose body
 * resolves to SELECT). Everything else — including anything the tokenizer
 * cannot make sense of — classifies as `write`.
 */
export function classifySql(sql: string): SqlClassification {
  const cleaned = stripComments(sql).trim();
  if (!cleaned) return "write";

  // Naive statement split is fine for a guard: a ';' inside a string literal
  // at worst makes the classifier MORE conservative (extra confirm), never
  // less.
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return "write";

  for (const statement of statements) {
    const first = statement.match(/^[a-zA-Z]+/)?.[0]?.toLowerCase();
    if (!first) return "write";
    if (["select", "explain", "show", "table", "values"].includes(first)) {
      continue;
    }
    if (first === "with") {
      // The statement after the CTE list decides. Find the first top-level
      // keyword following a closing paren + optional comma chain. A cheap
      // scan: any data-modifying keyword ANYWHERE in a WITH statement makes
      // it a write (CTEs themselves can contain INSERT ... RETURNING).
      if (
        /\b(insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|copy|call|do|vacuum|reindex|refresh|set|reset|comment|security|lock|cluster|analyze)\b/i.test(
          statement.slice(4),
        )
      ) {
        return "write";
      }
      continue;
    }
    return "write";
  }
  return "read";
}

export interface SqlRunResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
  classification: SqlClassification;
}

/**
 * Execute SQL and record the run in console_query_history (the audit trail
 * for this superuser surface). Two execution modes:
 *
 * - classified `read` and not confirmed → run inside a READ-ONLY transaction.
 *   Any actual write aborts with Postgres 25006, which is rethrown as
 *   ReadOnlyViolationError for the route to convert into a confirm prompt.
 *   This is the real guard: it does not trust the keyword, it lets Postgres
 *   decide whether the statement writes.
 * - classified `write`, OR `read` with `confirmedWrite` (the user knowingly
 *   ran e.g. `EXPLAIN ANALYZE UPDATE`) → run as-is.
 *
 * History writes are best-effort: losing one must not fail a query that ran.
 */
export async function runConsoleQuery(
  sql: string,
  ranBy: string,
  confirmedWrite = false,
): Promise<SqlRunResult> {
  const classification = classifySql(sql);
  const readOnly = classification === "read" && !confirmedWrite;
  // The wrapper preserves the inner SELECT's result rows (pg-meta returns the
  // last statement's rows) — verified against the live backend.
  const toRun = readOnly
    ? `begin transaction read only; ${sql}; commit;`
    : sql;
  const startedAt = Date.now();

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await runQuery(toRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (readOnly && isReadOnlyViolation(message)) {
      // Nothing executed (the txn aborted) — do not record; the route will
      // ask for confirmation, exactly like an up-front `write` classification.
      throw new ReadOnlyViolationError();
    }
    await recordHistory(sql, ranBy, Date.now() - startedAt, null, message);
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  await recordHistory(sql, ranBy, durationMs, rows.length, null);

  return {
    rows: rows.slice(0, MAX_RESULT_ROWS),
    rowCount: rows.length,
    truncated: rows.length > MAX_RESULT_ROWS,
    durationMs,
    classification,
  };
}

async function recordHistory(
  sql: string,
  ranBy: string,
  durationMs: number,
  rowCount: number | null,
  error: string | null,
): Promise<void> {
  const { error: insertError } = await history().insert({
    sql: sql.slice(0, HISTORY_SQL_MAX),
    ran_by: ranBy,
    duration_ms: Math.round(durationMs),
    row_count: rowCount,
    error,
  });
  if (insertError) {
    console.error(
      `[console:sql] history insert failed (ran_by ${ranBy}): ${insertError.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Snippets + history reads
// ---------------------------------------------------------------------------

export interface ConsoleSnippet {
  id: string;
  name: string;
  sql: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface HistoryEntry {
  id: string;
  sql: string;
  ran_by: string;
  ran_at: string;
  duration_ms: number | null;
  row_count: number | null;
  error: string | null;
}

/** Saved snippets, most recently touched first. */
export async function listSnippets(): Promise<ConsoleSnippet[]> {
  const { data, error } = await snippets()
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) fail("list-snippets", error.message);
  return (data ?? []) as ConsoleSnippet[];
}

export async function createSnippet(
  name: string,
  sql: string,
  createdBy: string,
): Promise<ConsoleSnippet> {
  const { data, error } = await snippets()
    .insert({ name, sql, created_by: createdBy })
    .select()
    .single();
  if (error) fail("create-snippet", error.message);
  return data as ConsoleSnippet;
}

export async function updateSnippet(
  id: string,
  patch: { name?: string; sql?: string },
): Promise<ConsoleSnippet | null> {
  const { data, error } = await snippets()
    .update({ ...patch, updated_at: nowIso() })
    .eq("id", id)
    .select()
    .maybeSingle();
  if (error) fail("update-snippet", error.message);
  return (data as ConsoleSnippet) ?? null;
}

export async function deleteSnippet(id: string): Promise<boolean> {
  const { data, error } = await snippets()
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) fail("delete-snippet", error.message);
  return data !== null;
}

/** Recent runs, newest first. */
export async function listHistory(limit = 50): Promise<HistoryEntry[]> {
  const { data, error } = await history()
    .select("*")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error) fail("list-history", error.message);
  return (data ?? []) as HistoryEntry[];
}
