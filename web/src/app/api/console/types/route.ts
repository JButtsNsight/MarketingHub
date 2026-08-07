import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { addEnumValue, listEnumTypes, OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { runQuery } from "@/lib/console/pgmeta";
import {
  isValidIdentifier,
  quoteLiteral,
  quoteQualified,
  MAX_IDENTIFIER_LEN,
} from "@/lib/console/identifiers";

/**
 * Enumerated-types surface (Studio → Database → Enumerated Types), gated on the
 * Cognito `marketing` group. Reads list `pg_type`/`pg_enum` for the surfaced
 * user schemas; the three DDL verbs are guarded in the client behind the
 * confirm modal.
 *
 *   GET    → list enum types (values ordered by enumsortorder)
 *   POST   {schema,name,values[]}  → CREATE TYPE … AS ENUM (…)
 *   PATCH  {schema,name,value}     → ALTER TYPE … ADD VALUE (irreversible)
 *   DELETE {schema,name}           → DROP TYPE …
 *
 * `addEnumValue` comes from the foundation; the foundation has no create/drop
 * for enum types, so those are built here from `runQuery` + the shared SQL-
 * safety helpers: every identifier is regex-validated AND existence-checked
 * against live `pg_catalog` before a quoted identifier is spliced into DDL, and
 * every label reaches SQL only through `quoteLiteral`. Any thrown
 * `[console:*] <op> failed: <msg>` maps to a 400 with the bare message, exactly
 * like /api/console/rows does for [console:tables].
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Postgres/DDL failures are user feedback in a console — surface as 400. */
const CONSOLE_ERR = /^\[console:[\w-]+\] [\w-]+ failed: /;
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && CONSOLE_ERR.test(err.message)) {
      return Response.json(
        { error: err.message.replace(CONSOLE_ERR, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Create/drop enum type — NOT in the foundation lib, so built here under the
// same SQL-safety contract as dbobjects.ts (validate + live existence-check
// before any quoted identifier reaches DDL). See `gaps` in the task report.
// ---------------------------------------------------------------------------

function fail(op: string, message: string): never {
  throw new Error(`[console:types] ${op} failed: ${message}`);
}

async function probe(sql: string): Promise<boolean> {
  const rows = await runQuery(sql);
  return rows[0]?.found === true;
}

function schemaExists(schema: string): Promise<boolean> {
  return probe(
    `select exists(
       select 1 from pg_catalog.pg_namespace where nspname = ${quoteLiteral(schema)}
     ) as found`,
  );
}

function enumTypeExists(schema: string, name: string): Promise<boolean> {
  return probe(
    `select exists(
       select 1
         from pg_catalog.pg_type t
         join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e'
          and n.nspname = ${quoteLiteral(schema)}
          and t.typname = ${quoteLiteral(name)}
     ) as found`,
  );
}

async function createEnumType(
  schema: string,
  name: string,
  values: string[],
): Promise<void> {
  if (!isValidIdentifier(schema)) fail("create-enum", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("create-enum", `invalid type: ${name}`);
  if (values.length === 0) fail("create-enum", "an enum needs at least one value");
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) {
      fail("create-enum", "enum values must be non-empty strings");
    }
  }
  if (!(await schemaExists(schema))) {
    fail("create-enum", `schema ${schema} does not exist`);
  }
  if (await enumTypeExists(schema, name)) {
    fail("create-enum", `type ${schema}.${name} already exists`);
  }
  const labels = values.map((v) => quoteLiteral(v)).join(", ");
  await runQuery(`create type ${quoteQualified(schema, name)} as enum (${labels})`);
}

async function dropEnumType(schema: string, name: string): Promise<void> {
  if (!isValidIdentifier(schema)) fail("drop-enum", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("drop-enum", `invalid type: ${name}`);
  if (!(await enumTypeExists(schema, name))) {
    fail("drop-enum", `enum type ${schema}.${name} does not exist`);
  }
  await runQuery(`drop type ${quoteQualified(schema, name)}`);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Only the surfaced schemas may be mutated (mirrors tables.ts' editor set). */
function knownSchema(schema: string): boolean {
  return OBJECT_SCHEMAS.includes(schema);
}

const CreateSchema = z.object({
  schema: z.string().min(1),
  name: z.string().min(1),
  values: z.array(z.string().min(1).max(MAX_IDENTIFIER_LEN)).min(1).max(200),
});

const AddValueSchema = z.object({
  schema: z.string().min(1),
  name: z.string().min(1),
  value: z.string().min(1).max(MAX_IDENTIFIER_LEN),
});

const DropSchema = z.object({
  schema: z.string().min(1),
  name: z.string().min(1),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const result = await consoleAttempt(() => listEnumTypes());
  if (result instanceof Response) return result;
  return Response.json({ types: result });
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
  const parsed = CreateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!knownSchema(parsed.data.schema)) {
    return Response.json({ error: "Unknown schema" }, { status: 400 });
  }

  const result = await consoleAttempt(async () => {
    await createEnumType(parsed.data.schema, parsed.data.name, parsed.data.values);
    return { schema: parsed.data.schema, name: parsed.data.name };
  });
  if (result instanceof Response) return result;
  return Response.json({ created: result }, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
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
  const parsed = AddValueSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!knownSchema(parsed.data.schema)) {
    return Response.json({ error: "Unknown schema" }, { status: 400 });
  }

  const result = await consoleAttempt(async () => {
    await addEnumValue(parsed.data.schema, parsed.data.name, parsed.data.value);
    return { schema: parsed.data.schema, name: parsed.data.name, value: parsed.data.value };
  });
  if (result instanceof Response) return result;
  return Response.json({ added: result });
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
  const parsed = DropSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  if (!knownSchema(parsed.data.schema)) {
    return Response.json({ error: "Unknown schema" }, { status: 400 });
  }

  const result = await consoleAttempt(async () => {
    await dropEnumType(parsed.data.schema, parsed.data.name);
    return { schema: parsed.data.schema, name: parsed.data.name };
  });
  if (result instanceof Response) return result;
  return Response.json({ dropped: result });
}
