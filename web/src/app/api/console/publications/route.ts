import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  dropPublication,
  listPublications,
  OBJECT_SCHEMAS,
  type PgPublication,
} from "@/lib/console/dbobjects";
import { listTables, runQuery } from "@/lib/console/pgmeta";
import {
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "@/lib/console/identifiers";

/**
 * Logical-replication publications (Studio → Database → Publications), gated on
 * the platform section.
 *
 * - GET    → every publication (name, owner, all-tables flag, insert/update/
 *            delete/truncate, member tables from pg_publication_tables) plus the
 *            live table list for the create/alter pickers.
 * - POST   → CREATE PUBLICATION (all tables OR a chosen table set + publish ops)
 * - PATCH  → ALTER PUBLICATION (publish ops; optional member-table replacement)
 * - DELETE → DROP PUBLICATION (delegates to the foundation dropPublication)
 *
 * The foundation `dbobjects` module only ships list + drop, so the create/alter
 * statements are assembled HERE — but under the same SQL-safety contract as the
 * rest of the console: the publication name and every table identifier are
 * validated against the regex allow-list (identifiers.ts) by zod, table targets
 * are additionally existence-checked against LIVE introspection before any DDL
 * is built, and the publish clause is assembled ONLY from fixed literals. No
 * caller string is ever concatenated raw into SQL run as supabase_admin.
 *
 * Every mutating verb is a DDL write; the client puts each behind the confirm
 * modal (controls-match-risk: guard the write, not the browse).
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * pg-meta / dbobjects failures (bad identifier, publication already exists,
 * unknown publication) are user feedback in this editor — surface as 400 with
 * the real Postgres message, stripping the internal `[console:*]` prefix.
 */
async function attempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (
      err instanceof Error &&
      /^\[console:(dbobjects|pgmeta)\] /.test(err.message)
    ) {
      return Response.json(
        { error: err.message.replace(/^\[console:\w+\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

export interface PublicationResponse extends PgPublication {
  /** Member tables ("schema.table") for a non-all-tables publication; [] otherwise. */
  tables: string[];
}

export interface TableRef {
  schema: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const IdentifierSchema = z
  .string()
  .refine(isValidIdentifier, { message: "must be a valid unquoted SQL identifier" });

const TableRefSchema = z.object({
  schema: IdentifierSchema,
  table: IdentifierSchema,
});

const PublishSchema = z.object({
  insert: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
  truncate: z.boolean(),
});

type Publish = z.infer<typeof PublishSchema>;

const hasAnyOp = (p: Publish) => p.insert || p.update || p.delete || p.truncate;

const CreateBodySchema = z
  .object({
    name: IdentifierSchema,
    allTables: z.boolean().default(false),
    tables: z.array(TableRefSchema).max(1000).default([]),
    publish: PublishSchema,
  })
  .refine((b) => hasAnyOp(b.publish), {
    message: "at least one publish operation is required",
  })
  .refine((b) => !(b.allTables && b.tables.length > 0), {
    message: "an all-tables publication cannot also list tables",
  });

const AlterBodySchema = z
  .object({
    name: IdentifierSchema,
    publish: PublishSchema,
    tables: z.array(TableRefSchema).max(1000).optional(),
  })
  .refine((b) => hasAnyOp(b.publish), {
    message: "at least one publish operation is required",
  });

const DeleteBodySchema = z.object({ name: IdentifierSchema });

// ---------------------------------------------------------------------------
// SQL assembly (identifiers already regex-validated by zod; quoted here too)
// ---------------------------------------------------------------------------

/** Build the `publish = '...'` value from validated booleans — fixed literals only. */
function publishList(p: Publish): string {
  const ops: string[] = [];
  if (p.insert) ops.push("insert");
  if (p.update) ops.push("update");
  if (p.delete) ops.push("delete");
  if (p.truncate) ops.push("truncate");
  return ops.join(", ");
}

function tableList(tables: Array<{ schema: string; table: string }>): string {
  return tables.map((t) => quoteQualified(t.schema, t.table)).join(", ");
}

function buildCreateSql(
  name: string,
  allTables: boolean,
  tables: Array<{ schema: string; table: string }>,
  publish: Publish,
): string {
  const scope = allTables
    ? " for all tables"
    : tables.length > 0
      ? ` for table ${tableList(tables)}`
      : "";
  return `create publication ${quoteIdent(name)}${scope} with (publish = ${quoteLiteral(publishList(publish))})`;
}

function buildAlterSql(
  name: string,
  publish: Publish,
  tables: Array<{ schema: string; table: string }> | undefined,
): string {
  const stmts = [
    `alter publication ${quoteIdent(name)} set (publish = ${quoteLiteral(publishList(publish))})`,
  ];
  // A `set table` needs at least one table (Postgres forbids an empty set); an
  // empty selection therefore leaves membership untouched — drop to fully empty.
  if (tables && tables.length > 0) {
    stmts.push(`alter publication ${quoteIdent(name)} set table ${tableList(tables)}`);
  }
  return stmts.join("; ");
}

// ---------------------------------------------------------------------------
// Live-introspection helpers
// ---------------------------------------------------------------------------

/** Set of "schema.name" for every table in the console's visible schemas. */
async function liveTableSet(): Promise<Set<string>> {
  const tables = await listTables(OBJECT_SCHEMAS);
  return new Set(tables.map((t) => `${t.schema}.${t.name}`));
}

/** First requested table that is NOT a live table, or null when all exist. */
function firstUnknown(
  tables: Array<{ schema: string; table: string }>,
  live: Set<string>,
): string | null {
  for (const t of tables) {
    if (!live.has(`${t.schema}.${t.table}`)) return `${t.schema}.${t.table}`;
  }
  return null;
}

/** Member tables per publication, keyed by publication name. */
async function publicationTables(): Promise<Map<string, string[]>> {
  const rows = await runQuery(
    `select pubname, schemaname, tablename
       from pg_catalog.pg_publication_tables
      order by pubname, schemaname, tablename`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const pub = String(r.pubname);
    const arr = map.get(pub) ?? [];
    arr.push(`${String(r.schemaname)}.${String(r.tablename)}`);
    map.set(pub, arr);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const result = await attempt(async () => {
    const [pubs, tableMap, tables] = await Promise.all([
      listPublications(),
      publicationTables(),
      listTables(OBJECT_SCHEMAS),
    ]);
    const publications: PublicationResponse[] = pubs.map((p) => ({
      ...p,
      tables: p.allTables ? [] : (tableMap.get(p.name) ?? []),
    }));
    const availableTables: TableRef[] = tables
      .map((t) => ({ schema: t.schema, name: t.name }))
      .sort((a, b) =>
        `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
      );
    return { publications, availableTables };
  });
  if (result instanceof Response) return result;
  return Response.json(result);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
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
  const { name, allTables, tables, publish } = parsed.data;

  // Existence-check every named table against live introspection BEFORE DDL.
  if (!allTables && tables.length > 0) {
    const live = await attempt(() => liveTableSet());
    if (live instanceof Response) return live;
    const unknown = firstUnknown(tables, live);
    if (unknown) {
      return Response.json({ error: `Unknown table: ${unknown}` }, { status: 400 });
    }
  }

  const done = await attempt(async () => {
    await runQuery(buildCreateSql(name, allTables, tables, publish));
    return { created: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = AlterBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { name, publish, tables } = parsed.data;

  const pubs = await attempt(() => listPublications());
  if (pubs instanceof Response) return pubs;
  const target = pubs.find((p) => p.name === name);
  if (!target) {
    return Response.json(
      { error: `Publication ${name} does not exist` },
      { status: 404 },
    );
  }

  if (tables && tables.length > 0) {
    if (target.allTables) {
      return Response.json(
        { error: "Cannot set member tables on an all-tables publication" },
        { status: 400 },
      );
    }
    const live = await attempt(() => liveTableSet());
    if (live instanceof Response) return live;
    const unknown = firstUnknown(tables, live);
    if (unknown) {
      return Response.json({ error: `Unknown table: ${unknown}` }, { status: 400 });
    }
  }

  const done = await attempt(async () => {
    await runQuery(buildAlterSql(name, publish, target.allTables ? undefined : tables));
    return { altered: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done);
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = DeleteBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const done = await attempt(async () => {
    await dropPublication(parsed.data.name);
    return { dropped: parsed.data.name };
  });
  if (done instanceof Response) return done;
  return Response.json(done);
}
