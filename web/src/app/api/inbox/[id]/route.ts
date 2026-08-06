import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { setInboundHandled } from "@/lib/sms/repo";

/**
 * Inbox workflow bit for one inbound message: PATCH {handled} marks a reply
 * handled (stamping who/when) or puts it back. A checkbox, not a state
 * machine — last write wins; only a missing row 404s.
 */

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

const PatchBodySchema = z.object({
  handled: z.boolean(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Message not found" }, { status: 404 });
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

  const message = await setInboundHandled(id, parsed.data.handled, user.email);
  if (!message) {
    return Response.json({ error: "Message not found" }, { status: 404 });
  }
  return Response.json({ message });
}
