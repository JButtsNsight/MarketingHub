import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { getUserClient } from "@/lib/supabase";
import { chunkStatus, NotProvisionedError } from "@/lib/intel/repo";

/**
 * Embed-status endpoint: honest asynchronous-embedding progress for one
 * document (status, chunk/embedded counts, provider models, last embed time).
 * The UI polls this while a document is 'pending'/'processing'.
 */

export const dynamic = "force-dynamic";

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
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    const status = await chunkStatus(id, db);
    if (!status) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }
    return Response.json({ status });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}
