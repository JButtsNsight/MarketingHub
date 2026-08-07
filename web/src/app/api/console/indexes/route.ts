import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { dropIndex, listIndexes, OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { listColumns, runQuery } from "@/lib/console/pgmeta";
import {
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "@/lib/console/identifiers";
import type { IndexRow } from "@/components/console/IndexesClient";

/**
 * Indexes surface (Studio Database → Indexes), gated on the Cognito `marketing`
 * group. GET enriches pg-meta's index list with `idx_scan` scan-counts from
 * `pg_stat_user_indexes` (a read — no confirm). POST creates an index from a
 * STRUCTURED definition and DELETE drops one; both are DDL and go behind the
 * client's confirm modal.
 *
 * SQL safety: `runQuery` runs as supabase_admin (SUPERUSER). Create validates
 * every identifier against BOTH the regex allow-list AND live introspection
 * (table + columns must exist) before a single quoted identifier is spliced in
 * — the index method is a fixed whitelist keyword. Drop delegates to the
 * foundation `dropIndex`, which does the same and refuses primary-key indexes.
 * No user string is ever concatenated raw into SQL.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Index access methods Studio offers — a fixed whitelist (never user text). */
const IndexMethod = z.enum(["btree", "hash", "gin", "gist", "brin", "spgist"]);
type IndexMethod = z.infer<typeof IndexMethod>;

function fail(op: string, message: string): never {
  throw new Error(`[console:indexes] ${op} failed: ${message}`);
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * DDL failures (our validation, the foundation's, or Postgres') are user
 * errors here — surface the real message as a 400, stripping the
 * `[console:*] <op> failed: ` prefix exactly like /api/console/rows does.
 */
function toBadRequest(err: unknown): Response {
  if (err instanceof Error) {
    const match = err.message.match(
      /^\[console:(?:indexes|dbobjects|pgmeta)\] [\w-]+ failed: ([\s\S]*)$/,
    );
    if (match) return Response.json({ error: match[1] }, { status: 400 });
  }
  throw err;
}

/**
 * The index list, enriched with `idx_scan` from pg_stat_user_indexes. The base
 * shape (schema/table/name/unique/primary/definition/bytes) is the foundation's
 * `listIndexes`; the scan-count is a separate catalog read merged by identity.
 * Exported so the server page can render the same rows without a waterfall.
 */
async function listIndexesWithStats(): Promise<IndexRow[]> {
  const schemaList = OBJECT_SCHEMAS.map((s) => quoteLiteral(s)).join(", ");
  const [indexes, statRows] = await Promise.all([
    listIndexes(OBJECT_SCHEMAS),
    runQuery(
      `select schemaname as schema,
              relname as "table",
              indexrelname as name,
              coalesce(idx_scan, 0)::int8 as idx_scan
         from pg_catalog.pg_stat_user_indexes
        where schemaname in (${schemaList})`,
    ),
  ]);
  const scans = new Map<string, number>();
  for (const r of statRows) {
    scans.set(`${r.schema}.${r.table}.${r.name}`, Number(r.idx_scan ?? 0));
  }
  return indexes.map((ix) => ({
    schema: ix.schema,
    table: ix.table,
    name: ix.name,
    isUnique: ix.isUnique,
    isPrimary: ix.isPrimary,
    definition: ix.definition,
    bytes: ix.bytes,
    idxScan: scans.get(`${ix.schema}.${ix.table}.${ix.name}`) ?? 0,
  }));
}

interface CreateIndexInput {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  method: IndexMethod;
}

/**
 * Build + run a `CREATE [UNIQUE] INDEX`. Every identifier is validated against
 * the regex allow-list and existence-checked against live introspection before
 * being quoted; the method comes from the fixed whitelist. No raw definition
 * string is accepted — arbitrary index DDL belongs in the SQL editor.
 */
async function createIndex(input: CreateIndexInput): Promise<void> {
  const { schema, table, name, columns, unique, method } = input;

  if (!isValidIdentifier(schema)) fail("create", `invalid schema: ${schema}`);
  if (!OBJECT_SCHEMAS.includes(schema)) fail("create", `schema not managed here: ${schema}`);
  if (!isValidIdentifier(table)) fail("create", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("create", `invalid index name: ${name}`);
  if (columns.length === 0) fail("create", "at least one column is required");
  for (const col of columns) {
    if (!isValidIdentifier(col)) fail("create", `invalid column: ${col}`);
  }
  if (!IndexMethod.options.includes(method)) {
    fail("create", `unsupported index method: ${method}`);
  }

  // Existence-check the table + every column against live introspection, so a
  // syntactically valid but non-existent identifier never reaches the DDL.
  const cols = await listColumns([schema]);
  const inTable = cols.filter((c) => c.table === table);
  if (inTable.length === 0) fail("create", `table ${schema}.${table} does not exist`);
  const known = new Set(inTable.map((c) => c.name));
  for (const col of columns) {
    if (!known.has(col)) fail("create", `unknown column: ${schema}.${table}.${col}`);
  }

  const colList = columns.map((c) => quoteIdent(c)).join(", ");
  await runQuery(
    `create ${unique ? "unique " : ""}index ${quoteIdent(name)} ` +
      `on ${quoteQualified(schema, table)} using ${method} (${colList})`,
  );
}

const CreateBodySchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  name: z.string().min(1).max(63),
  columns: z.array(z.string().min(1)).min(1).max(32),
  unique: z.boolean().optional().default(false),
  method: IndexMethod.optional().default("btree"),
});

const DropBodySchema = z.object({
  schema: z.string().min(1),
  name: z.string().min(1),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const indexes = await listIndexesWithStats();
  return Response.json({ indexes });
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    await createIndex(parsed.data);
  } catch (err) {
    return toBadRequest(err);
  }
  return Response.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = DropBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    await dropIndex(parsed.data.schema, parsed.data.name);
  } catch (err) {
    return toBadRequest(err);
  }
  return Response.json({ ok: true });
}
