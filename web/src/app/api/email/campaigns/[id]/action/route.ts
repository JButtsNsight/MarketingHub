import { headers } from "next/headers";
import { AuthError, requireUser } from "@/lib/auth";
import {
  BisonApiError,
  pauseCampaign,
  readConnection,
  resumeCampaign,
} from "@/lib/email/bison";

/**
 * EmailBison campaign pause/resume (Email Campaign Center). Marketing tier;
 * the browser never holds the API key — the route reads the runtime secret
 * and posts to the instance server-side. Not-connected is a 409: the action
 * cannot mean anything without an instance to act on.
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  let email: string;
  try {
    email = (await requireUser(await headers(), MARKETING_GROUP)).email;
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  // Path ids reach EmailBison as URL segments — accept digits only.
  const { id } = await context.params;
  const campaignId = /^\d+$/.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
    return Response.json({ error: "invalid campaign id" }, { status: 400 });
  }
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "pause" && action !== "resume") {
    return Response.json(
      { error: 'action must be "pause" or "resume"' },
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
    await (action === "pause" ? pauseCampaign : resumeCampaign)(
      conn,
      campaignId,
    );
  } catch (err) {
    if (err instanceof BisonApiError) {
      return Response.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
  console.log(
    JSON.stringify({
      evt: `emailbison.campaign.${action}`,
      by: email,
      campaignId,
    }),
  );
  return Response.json({ ok: true, action });
}
