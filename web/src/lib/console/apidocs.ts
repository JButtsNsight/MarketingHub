import "server-only";

import { listColumns, listTables, type PgColumn, type PgTable } from "./pgmeta";

/**
 * Data API reference — Studio "API Docs" parity.
 *
 * PURE + READ-ONLY. This module never runs SQL and never mutates. It reads the
 * live catalog through pg-meta (listTables / listColumns) and turns each table
 * into copy-pasteable PostgREST (rest/v1), supabase-js, and GraphQL examples.
 *
 * SQL safety: there is no `runQuery` here and no DDL. Every identifier baked
 * into a snippet comes from the TRUSTED catalog introspection — never from
 * request input — and the snippets are display strings, not executed SQL, so
 * there is no injection surface. The page layer still owns the auth gate: it
 * calls requireMarketingUser() before listApiDocEntries(), the same contract as
 * every other console surface.
 */

/** Schemas the reference documents (the PostgREST-exposed product schemas). */
export const API_DOC_SCHEMAS = ["marketinghub", "public"];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ApiDocColumn {
  name: string;
  /** Postgres data type ("uuid", "timestamp with time zone", …). */
  dataType: string;
  /** PostgREST format ("uuid", "timestamptz", "int4", enum name …). */
  format: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  isGenerated: boolean;
  defaultValue: string | null;
  enums: string[];
  comment: string | null;
}

export interface ApiDocTable {
  schema: string;
  name: string;
  comment: string | null;
  /** Empty = no primary key = no single-row update/delete example. */
  primaryKeys: string[];
  columns: ApiDocColumn[];
}

export interface ApiDocSnippets {
  restSelect: string;
  restInsert: string;
  restUpdate: string;
  restDelete: string;
  jsSelect: string;
  jsInsert: string;
  jsUpdate: string;
  jsDelete: string;
  graphql: string;
}

export interface ApiDocEntry {
  table: ApiDocTable;
  snippets: ApiDocSnippets;
}

// ---------------------------------------------------------------------------
// Introspection → DTOs (mirrors tables.ts mapping)
// ---------------------------------------------------------------------------

function toDocColumn(c: PgColumn, pks: Set<string>): ApiDocColumn {
  return {
    name: c.name,
    dataType: c.data_type,
    format: c.format,
    isNullable: c.is_nullable,
    isPrimaryKey: pks.has(c.name),
    isIdentity: c.is_identity,
    isGenerated: c.is_generated,
    defaultValue: c.default_value,
    enums: c.enums ?? [],
    comment: c.comment,
  };
}

function toDocTable(t: PgTable, columns: PgColumn[]): ApiDocTable {
  const pks = new Set(t.primary_keys.map((k) => k.name));
  return {
    schema: t.schema,
    name: t.name,
    comment: t.comment,
    primaryKeys: [...pks],
    columns: columns
      .filter((c) => c.schema === t.schema && c.table === t.name)
      .sort((a, b) => a.ordinal_position - b.ordinal_position)
      .map((c) => toDocColumn(c, pks)),
  };
}

/** Live tables + columns for the documented schemas, schema/name-sorted. */
export async function listApiDocTables(): Promise<ApiDocTable[]> {
  const [tables, columns] = await Promise.all([
    listTables(API_DOC_SCHEMAS),
    listColumns(API_DOC_SCHEMAS),
  ]);
  return tables
    .map((t) => toDocTable(t, columns))
    .sort(
      (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
    );
}

/** Each documented table paired with its rendered examples. */
export async function listApiDocEntries(): Promise<ApiDocEntry[]> {
  return (await listApiDocTables()).map(toApiDocEntry);
}

export function toApiDocEntry(table: ApiDocTable): ApiDocEntry {
  return { table, snippets: buildSnippets(table) };
}

// ---------------------------------------------------------------------------
// Snippet generation (pure)
// ---------------------------------------------------------------------------

const AUTH_HEADERS = [
  "apikey: $SUPABASE_SERVICE_ROLE_KEY",
  "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY",
];

/**
 * PostgREST selects the target schema by header. The default profile is
 * `public`, so only a non-public schema (e.g. marketinghub) needs one:
 * `Accept-Profile` for reads, `Content-Profile` for writes.
 */
function readHeaders(schema: string): string[] {
  return schema === "public"
    ? [...AUTH_HEADERS]
    : [`Accept-Profile: ${schema}`, ...AUTH_HEADERS];
}

function writeHeaders(schema: string): string[] {
  const profile = schema === "public" ? [] : [`Content-Profile: ${schema}`];
  return [
    ...profile,
    ...AUTH_HEADERS,
    "Content-Type: application/json",
    "Prefer: return=representation",
  ];
}

function curl(opts: {
  method?: string;
  path: string;
  query?: string;
  headers: string[];
  body?: string;
}): string {
  const url = `$SUPABASE_URL/rest/v1/${opts.path}${
    opts.query ? `?${opts.query}` : ""
  }`;
  const first =
    opts.method && opts.method !== "GET"
      ? `curl -X ${opts.method} "${url}"`
      : `curl "${url}"`;
  const lines = [first, ...opts.headers.map((h) => `  -H "${h}"`)];
  if (opts.body != null) lines.push(`  -d '${opts.body}'`);
  return lines.join(" \\\n");
}

/** A representative JSON value for a column, keyed off its PostgREST format. */
function sampleValue(col: ApiDocColumn): unknown {
  if (col.enums.length > 0) return col.enums[0];
  // Array formats prefix the element format with "_"; sample the element.
  const f = col.format.replace(/^_/, "");
  switch (f) {
    case "bool":
    case "boolean":
      return true;
    case "int2":
    case "int4":
    case "int8":
      return 1;
    case "numeric":
    case "float4":
    case "float8":
      return 1.5;
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    case "json":
    case "jsonb":
      return {};
    case "date":
      return "2026-01-01";
    case "timestamp":
    case "timestamptz":
      return "2026-01-01T00:00:00Z";
    case "time":
    case "timetz":
      return "00:00:00";
    default:
      return "value";
  }
}

/** Raw (unquoted) value for a `col=eq.<value>` querystring filter. */
function sampleFilterValue(col: ApiDocColumn): string {
  const v = sampleValue(col);
  return typeof v === "object" && v !== null ? "value" : String(v);
}

/** supabase-js `.eq()` literal: numbers/bools bare, everything else quoted. */
function jsFilterLiteral(col: ApiDocColumn): string {
  const v = sampleValue(col);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "\\'")}'`;
}

function selectList(t: ApiDocTable): string {
  return t.columns.length ? t.columns.map((c) => c.name).join(",") : "*";
}

/** Columns a client can write: identity/generated columns are never writable. */
function writableColumns(t: ApiDocTable): ApiDocColumn[] {
  const w = t.columns.filter((c) => !c.isIdentity && !c.isGenerated);
  return w.length ? w : t.columns;
}

function insertBody(t: ApiDocTable): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const c of writableColumns(t)) obj[c.name] = sampleValue(c);
  return obj;
}

/** Update example patches writable NON-key columns (falls back to writable). */
function patchBody(t: ApiDocTable): Record<string, unknown> {
  const pk = new Set(t.primaryKeys);
  const cols = writableColumns(t).filter((c) => !pk.has(c.name));
  const use = cols.length ? cols : writableColumns(t);
  const obj: Record<string, unknown> = {};
  for (const c of use) obj[c.name] = sampleValue(c);
  return obj;
}

/** Column an update/delete addresses a row by: the PK, else the first column. */
function filterColumn(t: ApiDocTable): ApiDocColumn | null {
  if (t.columns.length === 0) return null;
  const pk = t.primaryKeys[0];
  return (pk && t.columns.find((c) => c.name === pk)) || t.columns[0];
}

/** JSON, with every line after the first indented to sit under a `.method(`. */
function indentJson(value: unknown, pad: string): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n");
}

/** `.schema('x')` chain line, omitted for the default public schema. */
function jsSchemaLine(schema: string): string | null {
  return schema === "public" ? null : `  .schema('${schema}')`;
}

function joinJs(lines: Array<string | null>): string {
  return lines.filter((l): l is string => l != null).join("\n");
}

export function buildSnippets(t: ApiDocTable): ApiDocSnippets {
  const fc = filterColumn(t);
  const noAddress = "# table has no columns — add one to address a row";

  const restSelect = curl({
    path: t.name,
    query: `select=${selectList(t)}&limit=10`,
    headers: readHeaders(t.schema),
  });

  const restInsert = curl({
    method: "POST",
    path: t.name,
    headers: writeHeaders(t.schema),
    body: JSON.stringify(insertBody(t)),
  });

  const restUpdate = fc
    ? curl({
        method: "PATCH",
        path: t.name,
        query: `${fc.name}=eq.${sampleFilterValue(fc)}`,
        headers: writeHeaders(t.schema),
        body: JSON.stringify(patchBody(t)),
      })
    : noAddress;

  // DELETE carries no body; still needs the profile header on a non-public
  // schema to select the target, plus Prefer to echo the deleted rows.
  const deleteHeaders =
    t.schema === "public"
      ? [...AUTH_HEADERS, "Prefer: return=representation"]
      : [
          `Content-Profile: ${t.schema}`,
          ...AUTH_HEADERS,
          "Prefer: return=representation",
        ];
  const restDelete = fc
    ? curl({
        method: "DELETE",
        path: t.name,
        query: `${fc.name}=eq.${sampleFilterValue(fc)}`,
        headers: deleteHeaders,
      })
    : noAddress;

  const jsSelectCols = t.columns.length
    ? t.columns.map((c) => c.name).join(", ")
    : "*";

  const jsSelect = joinJs([
    "const { data, error } = await supabase",
    jsSchemaLine(t.schema),
    `  .from('${t.name}')`,
    `  .select('${jsSelectCols}')`,
    "  .limit(10)",
  ]);

  const jsInsert = joinJs([
    "const { data, error } = await supabase",
    jsSchemaLine(t.schema),
    `  .from('${t.name}')`,
    `  .insert(${indentJson(insertBody(t), "  ")})`,
    "  .select()",
  ]);

  const jsUpdate = joinJs([
    "const { data, error } = await supabase",
    jsSchemaLine(t.schema),
    `  .from('${t.name}')`,
    `  .update(${indentJson(patchBody(t), "  ")})`,
    fc ? `  .eq('${fc.name}', ${jsFilterLiteral(fc)})` : null,
    "  .select()",
  ]);

  const jsDelete = joinJs([
    "const { data, error } = await supabase",
    jsSchemaLine(t.schema),
    `  .from('${t.name}')`,
    "  .delete()",
    fc ? `  .eq('${fc.name}', ${jsFilterLiteral(fc)})` : null,
  ]);

  const gqlFields = (t.columns.length ? t.columns.map((c) => c.name) : ["nodeId"])
    .map((n) => `        ${n}`)
    .join("\n");
  const graphql = `query {
  ${t.name}Collection(first: 10) {
    edges {
      node {
${gqlFields}
      }
    }
  }
}`;

  return {
    restSelect,
    restInsert,
    restUpdate,
    restDelete,
    jsSelect,
    jsInsert,
    jsUpdate,
    jsDelete,
    graphql,
  };
}
