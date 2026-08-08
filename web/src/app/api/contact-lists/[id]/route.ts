import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import {
  deleteContactList,
  getContactList,
  getListMembers,
  listIsReferenced,
} from "@/lib/contacts/repo";

/**
 * Single contact-list API. Group-gated server-side on the Cognito `marketing`
 * group like the collection route. GET returns the list plus its parsed
 * members (csv lists; monday lists have none stored). DELETE refuses (409)
 * when any campaign was created from the list — provenance beats tidiness.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

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
  // Per-user client (RLS `authenticated` role) when SUPABASE_JWT_SECRET is
  // set; the service-role fallback otherwise — identical to before.
  const db = await getUserClient(user);

  const { id } = await context.params;
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "List not found" }, { status: 404 });
  }

  const list = await getContactList(id, db);
  if (!list) {
    return Response.json({ error: "List not found" }, { status: 404 });
  }

  const members = list.source === "csv" ? await getListMembers(id, db) : [];
  return Response.json({ list, members });
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
    return Response.json({ error: "List not found" }, { status: 404 });
  }

  if (await listIsReferenced(id, db)) {
    return Response.json(
      {
        error:
          "This list has campaigns built from it and can't be deleted — " +
          "campaign provenance is kept for audit.",
      },
      { status: 409 },
    );
  }

  const deleted = await deleteContactList(id, db);
  if (!deleted) {
    return Response.json({ error: "List not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
