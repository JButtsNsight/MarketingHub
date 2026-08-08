import "server-only";

import { getServiceClient } from "../supabase";
import {
  listColumns,
  listTables,
  type PgColumn,
  type PgTable,
} from "./pgmeta";

/**
 * Table Editor data layer — live pg-meta introspection for structure,
 * PostgREST (service role) for row CRUD. Every entry point validates the
 * requested schema/table/columns against the live introspection BEFORE
 * touching PostgREST, so nothing user-typed ever reaches `.schema()/.from()`
 * or a filter builder unchecked.
 *
 * The editor operates on the PostgREST-exposed schemas only — that is what
 * "editable through the data API" means here; the SQL editor covers the rest.
 */

/** Schemas the Table Editor serves (graphql_public holds no tables). */
export const EDITOR_SCHEMAS = ["marketinghub", "public", "storage"];

/**
 * Hand-editing these tables can break invariants the product depends on:
 * the outbox's at-most-once accounting, the STOP list (TCPA), audit evidence,
 * or storage-metadata ↔ S3 consistency. The console still allows it (owner
 * decision: full parity, guarded) — the UI shows a warning banner instead.
 */
export const SENSITIVE_TABLES = new Set([
  "marketinghub.sms_campaigns",
  "marketinghub.sms_campaign_recipients",
  "marketinghub.sms_suppressions",
  "marketinghub.sms_suppression_audit",
  "marketinghub.sms_webhook_events",
  "marketinghub.console_query_history",
  "storage.buckets",
  "storage.objects",
  // Vault holds encrypted secrets; selecting the decrypted view decrypts
  // EVERY row. All access goes through the Vault console (lib/console/vault).
  "vault.secrets",
  "vault.decrypted_secrets",
]);

/**
 * Browse-only in the Table Editor — writes are refused (403) regardless of
 * PostgREST grants. console_query_history is the audit trail for the console
 * itself; letting a marketing user DELETE/UPDATE their own run records from
 * the grid would gut it. Enforced in code (not a DB revoke) because every
 * migration re-runs `grant all on all tables to service_role`, which would
 * silently undo a revoke; this set cannot be re-granted away. The superuser
 * SQL-editor path still can (documented limitation — mirror to CloudWatch
 * for tamper-evidence).
 */
export const READ_ONLY_TABLES = new Set([
  "marketinghub.console_query_history",
  // Vault mutations happen ONLY through the Vault console page, which routes
  // create/update through vault.create_secret/update_secret (so values are
  // encrypted) and audits every action. Grid edits would write plaintext into
  // the ciphertext column. (The vault schema is not in EDITOR_SCHEMAS either;
  // this is the defense-in-depth layer should that ever change.)
  "vault.secrets",
  "vault.decrypted_secrets",
]);

export function isReadOnlyTable(schema: string, table: string): boolean {
  return READ_ONLY_TABLES.has(`${schema}.${table}`);
}

/** Rows per page (Studio default) and the cap a request may ask for. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export function isFilterOp(value: string): value is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(value);
}

export interface RowFilter {
  column: string;
  op: FilterOp;
  /** For op "is": "null" | "not.null"; otherwise the literal to compare. */
  value: string;
}

export interface EditorColumn {
  name: string;
  dataType: string;
  format: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  /** identity/generated columns can never be written through the editor. */
  isEditable: boolean;
  defaultValue: string | null;
  enums: string[];
  comment: string | null;
}

export interface EditorTable {
  schema: string;
  name: string;
  rowsEstimate: number;
  size: string;
  rlsEnabled: boolean;
  comment: string | null;
  /** Empty = no primary key = browse-only (no update/delete path). */
  primaryKeys: string[];
  sensitive: boolean;
  columns: EditorColumn[];
}

function fail(op: string, message: string): never {
  throw new Error(`[console:tables] ${op} failed: ${message}`);
}

function toEditorColumn(c: PgColumn, pks: Set<string>): EditorColumn {
  return {
    name: c.name,
    dataType: c.data_type,
    format: c.format,
    isNullable: c.is_nullable,
    isPrimaryKey: pks.has(c.name),
    isEditable: !c.is_identity && !c.is_generated,
    defaultValue: c.default_value,
    enums: c.enums ?? [],
    comment: c.comment,
  };
}

function toEditorTable(t: PgTable, columns: PgColumn[]): EditorTable {
  const pks = new Set(t.primary_keys.map((k) => k.name));
  return {
    schema: t.schema,
    name: t.name,
    rowsEstimate: t.live_rows_estimate,
    size: t.size,
    rlsEnabled: t.rls_enabled,
    comment: t.comment,
    primaryKeys: [...pks],
    sensitive: SENSITIVE_TABLES.has(`${t.schema}.${t.name}`),
    columns: columns
      .filter((c) => c.schema === t.schema && c.table === t.name)
      .sort((a, b) => a.ordinal_position - b.ordinal_position)
      .map((c) => toEditorColumn(c, pks)),
  };
}

/** Live table + column metadata for the editor schemas, name-sorted. */
export async function listEditorTables(): Promise<EditorTable[]> {
  const [tables, columns] = await Promise.all([
    listTables(EDITOR_SCHEMAS),
    listColumns(EDITOR_SCHEMAS),
  ]);
  return tables
    .map((t) => toEditorTable(t, columns))
    .sort(
      (a, b) =>
        a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
    );
}

/**
 * One table's metadata, or null when the schema.table does not exist in the
 * live introspection — the existence gate every row operation runs first.
 */
export async function getEditorTable(
  schema: string,
  table: string,
): Promise<EditorTable | null> {
  if (!EDITOR_SCHEMAS.includes(schema)) return null;
  const all = await listEditorTables();
  return all.find((t) => t.schema === schema && t.name === table) ?? null;
}

/** Assert every referenced column exists on the table (fail → null). */
function validColumns(meta: EditorTable, names: string[]): boolean {
  const known = new Set(meta.columns.map((c) => c.name));
  return names.every((n) => known.has(n));
}

export interface RowsPage {
  rows: Array<Record<string, unknown>>;
  total: number;
}

/**
 * One page of rows via PostgREST with exact count. Sort/filter columns are
 * validated against the table's live metadata; unknown columns fail loud
 * (the API route 400s before calling this with unvalidated input, so a
 * failure here means a coding error, not user error).
 */
export async function getRows(
  meta: EditorTable,
  opts: {
    page: number;
    pageSize: number;
    sort: { column: string; ascending: boolean } | null;
    filters: RowFilter[];
  },
): Promise<RowsPage> {
  const referenced = [
    ...(opts.sort ? [opts.sort.column] : []),
    ...opts.filters.map((f) => f.column),
  ];
  if (!validColumns(meta, referenced)) {
    fail("get-rows", "unknown column in sort/filter");
  }

  const pageSize = Math.min(Math.max(1, opts.pageSize), MAX_PAGE_SIZE);
  const from = Math.max(0, opts.page) * pageSize;

  let q = getServiceClient()
    .schema(meta.schema)
    .from(meta.name)
    .select("*", { count: "exact" });

  for (const f of opts.filters) {
    if (f.op === "is") {
      q = f.value === "not.null" ? q.not(f.column, "is", null) : q.is(f.column, null);
    } else {
      q = q.filter(f.column, f.op, f.value);
    }
  }

  if (opts.sort) {
    q = q.order(opts.sort.column, { ascending: opts.sort.ascending });
  } else if (meta.primaryKeys.length > 0) {
    // Stable pagination needs a deterministic order; PK is always indexed.
    q = q.order(meta.primaryKeys[0], { ascending: true });
  }

  const { data, error, count } = await q.range(from, from + pageSize - 1);
  if (error) fail("get-rows", error.message);
  return { rows: (data ?? []) as Array<Record<string, unknown>>, total: count ?? 0 };
}

/** Insert one row. Column names validated; values cast by Postgres. */
export async function insertRow(
  meta: EditorTable,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!validColumns(meta, Object.keys(values))) {
    fail("insert-row", "unknown column in values");
  }
  const { data, error } = await getServiceClient()
    .schema(meta.schema)
    .from(meta.name)
    .insert(values)
    .select()
    .single();
  if (error) fail("insert-row", error.message);
  return data as Record<string, unknown>;
}

/**
 * Update one row addressed by its FULL primary key. PK-less tables have no
 * update path (the API refuses them long before this).
 */
export async function updateRow(
  meta: EditorTable,
  pk: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (meta.primaryKeys.length === 0) fail("update-row", "table has no primary key");
  if (
    !validColumns(meta, Object.keys(patch)) ||
    Object.keys(pk).sort().join(",") !== [...meta.primaryKeys].sort().join(",")
  ) {
    fail("update-row", "unknown column in patch or incomplete primary key");
  }

  let q = getServiceClient().schema(meta.schema).from(meta.name).update(patch);
  for (const key of meta.primaryKeys) {
    q = q.eq(key, pk[key]);
  }
  const { data, error } = await q.select().maybeSingle();
  if (error) fail("update-row", error.message);
  return (data as Record<string, unknown>) ?? null;
}

/** Delete rows addressed by their FULL primary keys. Returns deleted count. */
export async function deleteRows(
  meta: EditorTable,
  keys: Array<Record<string, unknown>>,
): Promise<number> {
  if (meta.primaryKeys.length === 0) fail("delete-rows", "table has no primary key");
  const shape = [...meta.primaryKeys].sort().join(",");
  if (keys.some((k) => Object.keys(k).sort().join(",") !== shape)) {
    fail("delete-rows", "incomplete primary key");
  }

  // Single-column PKs delete in one .in() call; composite PKs go row-by-row
  // (PostgREST has no tuple-IN) — key counts here are page-sized, not bulk.
  if (meta.primaryKeys.length === 1) {
    const col = meta.primaryKeys[0];
    const { data, error } = await getServiceClient()
      .schema(meta.schema)
      .from(meta.name)
      .delete()
      .in(col, keys.map((k) => k[col]))
      .select(col);
    if (error) fail("delete-rows", error.message);
    return ((data ?? []) as unknown[]).length;
  }

  let deleted = 0;
  for (const key of keys) {
    let q = getServiceClient().schema(meta.schema).from(meta.name).delete();
    for (const col of meta.primaryKeys) q = q.eq(col, key[col]);
    const { data, error } = await q.select(meta.primaryKeys[0]);
    if (error) fail("delete-rows", error.message);
    deleted += ((data ?? []) as unknown[]).length;
  }
  return deleted;
}
