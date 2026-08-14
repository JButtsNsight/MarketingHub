import { headers } from "next/headers";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { getContactList } from "@/lib/contacts/repo";
import { BisonApiError, pushLeads, readConnection } from "@/lib/email/bison";
import { PUSH_LIST_CAP, loadPushableLeads } from "@/lib/email/pushList";

/**
 * Push a contact list into an EmailBison campaign (Email Campaign Center).
 * Marketing tier; the browser never holds the API key — the route reads the
 * runtime secret and calls the instance server-side. CSV-backed lists only
 * this round: stored members are read via the service-role repo idiom, then
 * upserted + attached through pushLeads. On ACTIVE campaigns Bison surfaces
 * attached leads on a ~5-minute sync cycle — the response says so.
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

const BodySchema = z.object({ contactListId: z.string().uuid() });

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireUser(await headers(), MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  // Bison campaign ids are integers — a non-numeric path id is not found.
  const { id } = await context.params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId < 1) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return Response.json(
      { error: "contactListId must be a uuid" },
      { status: 400 },
    );
  }
  const listId = body.data.contactListId;

  let conn;
  try {
    conn = await readConnection();
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "emailbison.connection.read-failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return Response.json(
      { error: "could not read the EmailBison connection" },
      { status: 502 },
    );
  }
  if (!conn) {
    return Response.json({ error: "EmailBison is not connected" }, { status: 409 });
  }

  const list = await getContactList(listId);
  if (!list) {
    return Response.json({ error: "List not found" }, { status: 404 });
  }
  // Monday lists resolve membership live at send time — not wired this round.
  if (list.source !== "csv") {
    return Response.json(
      { error: "Monday-backed lists aren't supported yet" },
      { status: 422 },
    );
  }

  const { leads, skipped: noEmail, overCap } = await loadPushableLeads(list.id);
  if (overCap) {
    return Response.json(
      {
        error: `list has more than ${PUSH_LIST_CAP.toLocaleString("en-US")} usable emails — too large for one push`,
      },
      { status: 422 },
    );
  }
  if (leads.length === 0) {
    return Response.json(
      { error: "no members with an email address" },
      { status: 422 },
    );
  }

  try {
    const out = await pushLeads(conn, campaignId, leads);
    // Every plausible email failed Bison's strict format gate — nothing pushed.
    if (out.attached === 0) {
      return Response.json(
        { error: "no members with an email address" },
        { status: 422 },
      );
    }
    const skipped = noEmail + out.skipped;
    console.log(
      JSON.stringify({
        evt: "emailbison.push-list",
        by: user.email,
        campaignId,
        listId,
        attached: out.attached,
        skipped,
      }),
    );
    return Response.json({
      attached: out.attached,
      skipped,
      message: out.message,
      note: "leads can take ~5 minutes to appear on active campaigns",
    });
  } catch (err) {
    if (err instanceof BisonApiError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
