import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  dropExtension,
  enableExtension,
  listInstalledExtensions,
} from "@/lib/console/dbobjects";

/**
 * Postgres extensions (Studio Database → Extensions), gated on the Cognito
 * platform section. pg-meta runs everything as supabase_admin, so both writes
 * here are DDL run as superuser:
 *
 * - GET                → pg_available_extensions joined to installed state
 * - POST   {name}      → CREATE EXTENSION (enable) behind the client confirm
 * - DELETE {name}      → DROP EXTENSION (disable) behind the client confirm
 *
 * The extension name is never concatenated raw: `enableExtension` validates it
 * against the identifier allow-list AND pg-meta's live available-extensions
 * catalog, and `dropExtension` refuses anything not currently installed. Any
 * thrown `[console:dbobjects] <op> failed: <msg>` surfaces as a 400 carrying
 * the real message (mirroring /api/console/rows).
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** DDL failures (unknown extension, dependency cascade) are user feedback → 400. */
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

const EnableBodySchema = z.object({
  name: z.string().min(1).max(63),
  // Optional target schema/version — pg-meta chooses defaults when omitted.
  schema: z.string().min(1).max(63).optional(),
  version: z.string().min(1).max(100).optional(),
});

const DropBodySchema = z.object({
  name: z.string().min(1).max(63),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const extensions = await listInstalledExtensions();
  return Response.json({ extensions });
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
  const parsed = EnableBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, schema, version } = parsed.data;
  const result = await dbAttempt(async () => {
    await enableExtension(name, { schema, version });
    return { enabled: name };
  });
  if (result instanceof Response) return result;
  return Response.json(result, { status: 201 });
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
  const parsed = DropBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await dbAttempt(async () => {
    await dropExtension(parsed.data.name);
    return { dropped: parsed.data.name };
  });
  if (result instanceof Response) return result;
  return Response.json(result);
}
