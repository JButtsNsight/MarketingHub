import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import {
  deleteDocument,
  getDocument,
  NotProvisionedError,
} from "@/lib/intel/repo";

/**
 * Single competitor-intel document. GET returns the full row (including the
 * pasted content). DELETE cascades chunks DB-side; any in-flight queue
 * message for it becomes a no-op in the consumer (document gone ⇒ archived).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

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
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    const document = await getDocument(id, db);
    if (!document) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    return Response.json({ document });
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
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    const deleted = await deleteDocument(id, db);
    if (!deleted) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}
