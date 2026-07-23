import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import {
  cancelCampaign,
  getCampaign,
  getCampaignCounts,
  getCampaignRecipients,
  pauseCampaign,
  resumeCampaign,
} from "@/lib/sms/repo";
import type { SmsCampaign } from "@/lib/sms/schema";

/**
 * Single-campaign API. Group-gated server-side on the Cognito `marketing`
 * group, like the collection route. PATCH drives the campaign state machine
 * through the repo's CONDITIONAL transitions: a `null` result means the
 * status guard lost (the campaign was not in a state the action applies to)
 * and maps to 409 — the client refetches and sees the fresh status.
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
function isUuid(value: string): boolean {
  return UuidSchema.safeParse(value).success;
}

const PatchBodySchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
});

type CampaignAction = z.infer<typeof PatchBodySchema>["action"];

const TRANSITIONS: Record<
  CampaignAction,
  (id: string) => Promise<SmsCampaign | null>
> = {
  pause: pauseCampaign,
  resume: resumeCampaign,
  cancel: cancelCampaign,
};

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }
  const campaign = await getCampaign(id);
  if (!campaign) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
  }

  const [counts, recipients] = await Promise.all([
    getCampaignCounts(id),
    getCampaignRecipients(id),
  ]);
  return Response.json({ campaign, counts, recipients });
}

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
  if (!isUuid(id)) {
    return Response.json({ error: "Campaign not found" }, { status: 404 });
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

  const campaign = await TRANSITIONS[parsed.data.action](id);
  if (!campaign) {
    return Response.json(
      { error: `Campaign is not in a state that allows ${parsed.data.action}` },
      { status: 409 },
    );
  }
  return Response.json({ campaign });
}
