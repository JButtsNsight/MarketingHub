import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { getServiceClient } from "@/lib/supabase";
import { listColumns, listTables, type PgColumn } from "@/lib/console/pgmeta";
import { EDITOR_SCHEMAS } from "@/lib/console/tables";
import { clampLimit, isValidIdentifier } from "@/lib/console/identifiers";

/**
 * Foreign-key row picker source for the Table Editor, gated on the Cognito
 * platform section. Two read-only modes, one endpoint:
 *
 *   GET ?schema&table                 → { relationships }  (the table's FK map)
 *   GET ?schema&table&column[&search] → { column, target, options }  (rows)
 *
 * The editor renders a dropdown of referenced-table rows (referenced column +
 * a display column) instead of a free-text cell for FK columns; this route
 * supplies both the FK map (which columns are FKs) and the candidate rows.
 *
 * These are READS, so no write-confirm applies — but the section gate does,
 * exactly like every other console route. The schema/table/column are validated
 * against LIVE introspection before anything is queried: the source table must
 * exist in the PostgREST-exposed schemas, the column must actually be a foreign
 * key on it, and the referenced (target) table/column must exist. Candidate
 * rows are fetched through PostgREST (service role) selecting only the
 * referenced value + display column — the same data path tables.ts uses — so no
 * SQL is built here; identifiers are nonetheless re-validated defensively.
 */

export const dynamic = "force-dynamic";

/** Dropdown size defaults — a picker is a shortlist, not the whole table. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Column names that make a good human label, most-specific first. The first one
 * present on the target table (and not the referenced value column itself) wins.
 */
const DISPLAY_PREFERENCES = [
  "name",
  "title",
  "label",
  "display_name",
  "full_name",
  "email",
  "subject",
  "slug",
  "description",
  "key",
];

/** PostgREST format names we treat as text for the display-column fallback. */
const TEXT_FORMATS = new Set([
  "text",
  "varchar",
  "character varying",
  "bpchar",
  "citext",
  "name",
  "char",
]);

export interface FkRelationship {
  /** The foreign-key column on the source table. */
  column: string;
  targetSchema: string;
  targetTable: string;
  /** The referenced column on the target table (the value stored in the FK). */
  targetColumn: string;
}

export interface FkOption {
  value: string;
  label: string;
}

export interface FkTarget {
  schema: string;
  table: string;
  valueColumn: string;
  displayColumn: string;
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

function fail(op: string, message: string): never {
  throw new Error(`[console:fk-options] ${op} failed: ${message}`);
}

/**
 * Introspection/PostgREST failures are user-visible errors here — surface the
 * real message as a 400, stripping the `[console:*] <op> failed: ` prefix
 * exactly like /api/console/rows and the other console routes do.
 */
function toBadRequest(err: unknown): Response {
  if (err instanceof Error) {
    const match = err.message.match(
      /^\[console:(?:fk-options|pgmeta|tables)\] [\w-]+ failed: ([\s\S]*)$/,
    );
    if (match) return Response.json({ error: match[1] }, { status: 400 });
  }
  throw err;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The FK relationships whose SOURCE is this table, resolved from live
 * introspection. Returns null when the table does not exist in the exposed
 * schemas (→ 404) so the caller can distinguish "no FKs" from "no table".
 */
async function fkRelationships(
  schema: string,
  table: string,
): Promise<FkRelationship[] | null> {
  const tables = await listTables(EDITOR_SCHEMAS);
  const t = tables.find((x) => x.schema === schema && x.name === table);
  if (!t) return null;
  return (t.relationships ?? [])
    .filter(
      (r) => r.source_schema === schema && r.source_table_name === table,
    )
    .map((r) => ({
      column: r.source_column_name,
      targetSchema: r.target_table_schema,
      targetTable: r.target_table_name,
      targetColumn: r.target_column_name,
    }));
}

/** First good display column for the target table, else the value column. */
function pickDisplayColumn(cols: PgColumn[], valueColumn: string): string {
  const byName = new Map(cols.map((c) => [c.name, c]));
  for (const pref of DISPLAY_PREFERENCES) {
    if (byName.has(pref) && pref !== valueColumn) return pref;
  }
  const textCol = cols
    .filter((c) => c.name !== valueColumn)
    .sort((a, b) => a.ordinal_position - b.ordinal_position)
    .find((c) => TEXT_FORMATS.has(c.format));
  return textCol?.name ?? valueColumn;
}

/**
 * Candidate rows for one FK: the referenced value + a display label, fetched
 * through PostgREST (service role) against the target table. Existence-checks
 * the target table + referenced column against introspection first.
 */
async function fetchOptions(
  rel: FkRelationship,
  search: string,
  limit: number,
): Promise<{ target: FkTarget; options: FkOption[] }> {
  const cols = (await listColumns([rel.targetSchema])).filter(
    (c) => c.table === rel.targetTable,
  );
  if (cols.length === 0) {
    fail(
      "options",
      `target table ${rel.targetSchema}.${rel.targetTable} does not exist`,
    );
  }
  const known = new Set(cols.map((c) => c.name));
  if (!known.has(rel.targetColumn)) {
    fail("options", `referenced column ${rel.targetColumn} does not exist`);
  }

  const displayColumn = pickDisplayColumn(cols, rel.targetColumn);
  // Defense-in-depth: these came from the catalog, but nothing reaches the data
  // layer without passing the same identifier allow-list DDL callers use.
  if (!isValidIdentifier(rel.targetColumn) || !isValidIdentifier(displayColumn)) {
    fail("options", "invalid target identifier");
  }

  const hasDisplay = displayColumn !== rel.targetColumn;
  const selectCols = hasDisplay
    ? `${rel.targetColumn},${displayColumn}`
    : rel.targetColumn;

  let q = getServiceClient()
    .schema(rel.targetSchema)
    .from(rel.targetTable)
    .select(selectCols);
  // Only ilike a distinct display column (searching a uuid/int value column errors).
  if (search && hasDisplay) q = q.ilike(displayColumn, `%${search}%`);
  q = q.order(displayColumn, { ascending: true }).limit(limit);

  const { data, error } = await q;
  if (error) fail("options", error.message);

  const options: FkOption[] = [];
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const value = display(row[rel.targetColumn]);
    if (value === "") continue;
    const label = hasDisplay
      ? `${display(row[displayColumn]) || value} · ${value}`
      : value;
    options.push({ value, label });
  }

  return {
    target: {
      schema: rel.targetSchema,
      table: rel.targetTable,
      valueColumn: rel.targetColumn,
      displayColumn,
    },
    options,
  };
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const schema = url.searchParams.get("schema") ?? "";
  const table = url.searchParams.get("table") ?? "";
  const column = url.searchParams.get("column");
  const search = url.searchParams.get("search") ?? "";
  const rawLimit = url.searchParams.get("limit");
  const limit = clampLimit(
    rawLimit === null ? undefined : Number(rawLimit),
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  if (!schema || !table) {
    return Response.json(
      { error: "schema and table are required" },
      { status: 400 },
    );
  }
  if (!isValidIdentifier(schema) || !isValidIdentifier(table)) {
    return Response.json({ error: "invalid schema or table" }, { status: 400 });
  }
  if (!EDITOR_SCHEMAS.includes(schema)) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }

  let relationships: FkRelationship[] | null;
  try {
    relationships = await fkRelationships(schema, table);
  } catch (err) {
    return toBadRequest(err);
  }
  if (!relationships) {
    return Response.json({ error: "Table not found" }, { status: 404 });
  }

  // Mode 1 — the table's FK map (which columns are foreign keys).
  if (!column) {
    return Response.json({ relationships });
  }

  // Mode 2 — candidate rows for one FK column.
  if (!isValidIdentifier(column)) {
    return Response.json({ error: "invalid column" }, { status: 400 });
  }
  const rel = relationships.find((r) => r.column === column);
  if (!rel) {
    return Response.json(
      { error: "column is not a foreign key" },
      { status: 400 },
    );
  }

  // A FK can point at a schema the data API does not expose (e.g. auth.*); we
  // can't browse it through PostgREST, so report it as unsupported and let the
  // editor fall back to a free-text cell rather than an empty, misleading picker.
  if (!EDITOR_SCHEMAS.includes(rel.targetSchema)) {
    return Response.json({
      column,
      target: {
        schema: rel.targetSchema,
        table: rel.targetTable,
        valueColumn: rel.targetColumn,
        displayColumn: rel.targetColumn,
      },
      options: [],
      unsupported: true,
    });
  }

  try {
    const { target, options } = await fetchOptions(rel, search, limit);
    return Response.json({ column, target, options });
  } catch (err) {
    return toBadRequest(err);
  }
}
