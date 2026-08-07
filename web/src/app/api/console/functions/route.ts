import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { dropFunction, listFunctions } from "@/lib/console/dbobjects";
import { assertSafeInteger } from "@/lib/console/identifiers";
import { runQuery } from "@/lib/console/pgmeta";

/**
 * Database → Functions (Studio parity). Lists routines from pg_proc across the
 * marketinghub / public / pgmq_public schemas (name, args, return type,
 * language, security-definer flag), serves a single function's definition on
 * demand (read), and drops a function by OID.
 *
 * Every verb is gated on the Cognito `marketing` group (mirrors
 * /api/console/rows). The DROP is destructive — the client gates it behind the
 * confirm modal; the server still validates the OID as a safe integer and lets
 * postgres-meta be the source of truth for existence. Any thrown
 * `[console:*] <op> failed: <msg>` maps to a 400 with the bare message.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Routines the Functions page surfaces (matches the surface spec). */
const FUNCTION_SCHEMAS = ["marketinghub", "public", "pgmq_public"];

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Postgres/pg-meta failures are user errors here — surface as 400. */
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (
      err instanceof Error &&
      /^\[console:[\w-]+\] [\w-]+ failed: /.test(err.message)
    ) {
      return Response.json(
        { error: err.message.replace(/^\[console:[\w-]+\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * The full definition of one function, keyed only by its (validated) OID —
 * derived entirely inside Postgres, so no caller string is spliced in.
 * `pg_get_functiondef` is undefined for aggregate/window routines, so those
 * return a null definition (the client shows an explanatory note instead).
 */
async function functionDefinition(
  oid: number,
): Promise<{ definition: string | null; kind: string } | null> {
  const id = assertSafeInteger(oid, "function oid");
  const rows = await runQuery(
    `select case when p.prokind in ('a', 'w') then null
                 else pg_catalog.pg_get_functiondef(p.oid) end as definition,
            case p.prokind
              when 'f' then 'function'
              when 'p' then 'procedure'
              when 'a' then 'aggregate'
              when 'w' then 'window'
              else p.prokind::text
            end as kind
       from pg_catalog.pg_proc p
      where p.oid = ${id}`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    definition: (row.definition as string | null) ?? null,
    kind: String(row.kind ?? "function"),
  };
}

const OidQuery = z.coerce.number().int().nonnegative().safe();

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const rawOid = url.searchParams.get("oid");

  // Definition mode: `?oid=<n>` returns just that routine's source.
  if (rawOid !== null) {
    const parsed = OidQuery.safeParse(rawOid);
    if (!parsed.success) {
      return Response.json({ error: "oid must be a non-negative integer" }, { status: 400 });
    }
    const result = await consoleAttempt(() => functionDefinition(parsed.data));
    if (result instanceof Response) return result;
    if (!result) {
      return Response.json({ error: "Function not found" }, { status: 404 });
    }
    return Response.json(result);
  }

  // List mode.
  const result = await consoleAttempt(() => listFunctions(FUNCTION_SCHEMAS));
  if (result instanceof Response) return result;
  return Response.json({ functions: result });
}

const DeleteBodySchema = z.object({
  oid: z.number().int().nonnegative().safe(),
});

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
  const parsed = DeleteBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await consoleAttempt(() => dropFunction(parsed.data.oid));
  if (result instanceof Response) return result;
  return Response.json({ dropped: true });
}
