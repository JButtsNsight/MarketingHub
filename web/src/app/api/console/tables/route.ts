import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { listEditorTables } from "@/lib/console/tables";

/**
 * Table Editor metadata: live pg-meta introspection (tables + columns + PKs +
 * sensitivity flags) for the PostgREST-exposed schemas. Read-only; the row
 * CRUD lives in /api/console/rows.
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const tables = await listEditorTables();
  return Response.json({ tables });
}
