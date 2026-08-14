import { headers } from "next/headers";
import { AuthError, requireUser } from "@/lib/auth";
import {
  BisonApiError,
  createCampaign,
  readConnection,
} from "@/lib/email/bison";

/**
 * EmailBison campaign create (Email Campaign Center). Marketing tier; the
 * browser never holds the API key — the route reads the runtime secret and
 * posts to the instance server-side. New campaigns are outbound and born in
 * Draft (EmailBison's contract). Not-connected is a 409.
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";
/** Display-name gate only — EmailBison enforces its own limits upstream. */
const NAME_MAX = 200;

export async function POST(req: Request): Promise<Response> {
  let email: string;
  try {
    email = (await requireUser(await headers(), MARKETING_GROUP)).email;
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  let body: { name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > NAME_MAX) {
    return Response.json(
      { error: `name must be 1–${NAME_MAX} characters` },
      { status: 400 },
    );
  }
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
    return Response.json(
      { error: "EmailBison is not connected" },
      { status: 409 },
    );
  }
  try {
    const campaign = await createCampaign(conn, name);
    console.log(
      JSON.stringify({
        evt: "emailbison.campaign.created",
        by: email,
        campaignId: campaign.id,
        name: campaign.name,
      }),
    );
    return Response.json(campaign);
  } catch (err) {
    if (err instanceof BisonApiError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
