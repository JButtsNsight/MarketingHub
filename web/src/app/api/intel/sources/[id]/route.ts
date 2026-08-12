import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { readJsonBodyBounded } from "@/lib/jsonBody";
import { getUserClient } from "@/lib/supabase";
import {
  deleteSource,
  getSource,
  listDocumentsBySource,
  NotProvisionedError,
  updateSource,
} from "@/lib/intel/repo";
import { SourceUpdateInputSchema } from "@/lib/intel/schema";

/**
 * Single competitor-intel source. Group-gated server-side like the collection
 * route. GET returns the source plus its documents (summaries — no content
 * bodies). DELETE cascades documents/chunks DB-side.
 */

export const dynamic = "force-dynamic";

/**
 * Path params reach PostgREST as uuid filters — a non-UUID would trigger
 * Postgres 22P02 (thrown → 500). Guard up front: not a UUID = not found.
 */
const UuidSchema = z.string().uuid();

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Honest 503 while the competitor_intel substrate is not applied yet. */
function notProvisionedResponse(err: NotProvisionedError): Response {
  return Response.json(
    { error: "intel-not-provisioned", message: err.message },
    { status: 503 },
  );
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Source not found" }, { status: 404 });
  }

  try {
    const source = await getSource(id, db);
    if (!source) {
      return Response.json({ error: "Source not found" }, { status: 404 });
    }
    const documents = await listDocumentsBySource(id, db);
    return Response.json({ source, documents });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Source not found" }, { status: 404 });
  }

  // Bounded read BEFORE parse (house guard: a bare req.json() buffers the
  // whole body before Zod runs — an OOM lever). The 256KB default dwarfs the
  // largest legitimate source patch (name 200 + url + notes 4000 chars).
  const read = await readJsonBodyBounded(req);
  if (!read.ok) return read.response;

  const parsed = SourceUpdateInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = await getUserClient(user);
  try {
    const source = await updateSource(id, parsed.data, db);
    if (!source) {
      return Response.json({ error: "Source not found" }, { status: 404 });
    }
    return Response.json({ source });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Source not found" }, { status: 404 });
  }

  try {
    const deleted = await deleteSource(id, db);
    if (!deleted) {
      return Response.json({ error: "Source not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}
