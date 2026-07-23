import { AuthError, requireUser } from "@/lib/auth";
import { MondayConfigError } from "@/lib/monday/client";
import { fetchBoardRecipients } from "@/lib/monday/boards";
import {
  createCampaign,
  findActiveDuplicateCampaign,
  getSuppressedSet,
  listCampaignsWithCounts,
  prepareRecipients,
  type PreparedRecipient,
} from "@/lib/sms/repo";
import { CampaignCreateInputSchema } from "@/lib/sms/schema";
import { unsupportedMergeFields } from "@/lib/sms/render";
import { sendAtForEasternDate } from "@/lib/sms/schedule";
import { getTemplate } from "@/lib/templates/repo";

/**
 * SMS campaigns collection API. Group-gated SERVER-SIDE on the Cognito
 * `marketing` group (via `requireUser`); the service-role Supabase client is
 * only reached through the repos. POST snapshots everything at creation time:
 * the template body, the computed 11:30 AM America/New_York send instant, and
 * the full Monday board (every page) classified into outbox rows.
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/** Map an AuthError to its HTTP response; rethrow anything else. */
function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** The creation-summary counts returned with the 201. */
function summarize(prepared: PreparedRecipient[]) {
  const counts = { pending: 0, skipped: 0, suppressed: 0, total: prepared.length };
  for (const row of prepared) counts[row.status] += 1;
  return counts;
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = CampaignCreateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // The message body is snapshotted from a text template that must be fully
  // renderable — unknown merge fields would otherwise reach patients verbatim.
  const template = await getTemplate(input.templateId);
  if (!template) {
    return Response.json({ error: "Template not found" }, { status: 400 });
  }
  if (template.type !== "text") {
    return Response.json(
      { error: "Template must be a text (SMS) template" },
      { status: 400 },
    );
  }
  const unsupported = unsupportedMergeFields(template.body);
  if (unsupported.length > 0) {
    return Response.json(
      {
        error: `Template has unsupported merge fields: ${unsupported.join(", ")}`,
      },
      { status: 400 },
    );
  }

  if (sendAtForEasternDate(input.sendDate).getTime() <= Date.now()) {
    return Response.json(
      { error: "sendDate must be in the future (11:30 AM Eastern)" },
      { status: 400 },
    );
  }

  // Idempotency backstop BEFORE the (slow) Monday fetch: the same template +
  // board + send date still live means a double-submit, not a new campaign.
  const duplicate = await findActiveDuplicateCampaign(
    input.templateId,
    input.mondayBoardId,
    input.sendDate,
  );
  if (duplicate) {
    return Response.json(
      { error: "duplicate-campaign", existingId: duplicate.id },
      { status: 409 },
    );
  }

  // Every page of the board — the preview's first-page sample is advisory.
  let mondayRows;
  try {
    mondayRows = await fetchBoardRecipients(
      input.mondayBoardId,
      input.mondayPhoneColumnId,
    );
  } catch (err) {
    if (err instanceof MondayConfigError) {
      return Response.json({ error: "monday-not-configured" }, { status: 503 });
    }
    throw err;
  }

  const suppressed = await getSuppressedSet(mondayRows.map((r) => r.phoneE164));
  const prepared = prepareRecipients(mondayRows, template.body, suppressed);
  const campaign = await createCampaign(input, template.body, prepared, {
    email: user.email,
  });

  return Response.json(
    { id: campaign.id, counts: summarize(prepared) },
    { status: 201 },
  );
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const campaigns = await listCampaignsWithCounts();
  return Response.json({ campaigns });
}
