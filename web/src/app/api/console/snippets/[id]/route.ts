import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { deleteSnippet, updateSnippet } from "@/lib/console/sql";

/** Rename/update/delete one saved snippet. */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * Path params reach PostgREST as uuid filters — a non-UUID would trigger
 * Postgres 22P02 (thrown → 500). Guard up front: not a UUID = not found.
 */
const UuidSchema = z.string().uuid();

const PatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    sql: z.string().trim().min(1).max(100_000).optional(),
  })
  .refine((p) => p.name !== undefined || p.sql !== undefined, {
    message: "patch must set name or sql",
  });

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Snippet not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PatchBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const snippet = await updateSnippet(id, parsed.data);
  if (!snippet) {
    return Response.json({ error: "Snippet not found" }, { status: 404 });
  }
  return Response.json({ snippet });
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Snippet not found" }, { status: 404 });
  }

  const removed = await deleteSnippet(id);
  if (!removed) {
    return Response.json({ error: "Snippet not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
