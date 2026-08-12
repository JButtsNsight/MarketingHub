import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  dropTrigger,
  listTriggers,
  setTriggerEnabled,
} from "@/lib/console/dbobjects";
import { isValidIdentifier } from "@/lib/console/identifiers";

/**
 * Database → Triggers, gated on the platform section. GET lists the
 * user-schema triggers (pg_trigger joined to pg_class/pg_proc) from live
 * introspection; PATCH enables/disables a trigger and DELETE drops it. Every
 * write is DDL run as `supabase_admin`, so the target's schema/table/name are
 * validated against the identifier allow-list here (fast 400) AND re-validated
 * + existence-checked inside the foundation lib before any statement is built —
 * no caller string is ever concatenated raw into SQL.
 *
 * `[console:dbobjects] <op> failed: <msg>` from the lib surfaces as a 400 with
 * the real Postgres message, exactly like /api/console/rows does for
 * [console:tables].
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** DDL failures (bad/absent identifier, dependent objects) are user errors → 400. */
async function dbAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:dbobjects]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:dbobjects\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

const identifier = z
  .string()
  .refine(isValidIdentifier, { message: "invalid identifier" });

const TargetSchema = z.object({
  schema: identifier,
  table: identifier,
  name: identifier,
});

const PatchSchema = TargetSchema.extend({ enabled: z.boolean() });

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const result = await dbAttempt(() => listTriggers());
  if (result instanceof Response) return result;
  return Response.json({ triggers: result });
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
  const parsed = PatchSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { schema, table, name, enabled } = parsed.data;
  const result = await dbAttempt(() =>
    setTriggerEnabled(schema, table, name, enabled),
  );
  if (result instanceof Response) return result;
  return Response.json({ ok: true, enabled });
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
  const parsed = TargetSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { schema, table, name } = parsed.data;
  const result = await dbAttempt(() => dropTrigger(schema, table, name));
  if (result instanceof Response) return result;
  return Response.json({ ok: true });
}
