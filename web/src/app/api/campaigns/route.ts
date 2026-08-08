import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import { MondayConfigError } from "@/lib/monday/client";
import { fetchBoardRecipients, getBoardMeta } from "@/lib/monday/boards";
import { getContactList, getSendableMembers } from "@/lib/contacts/repo";
import {
  createCampaign,
  findActiveDuplicateCampaign,
  getSuppressedSet,
  listCampaignsWithCounts,
  prepareRecipients,
  type PreparedRecipient,
  type SourceRecipientRow,
} from "@/lib/sms/repo";
import { CampaignCreateInputSchema } from "@/lib/sms/schema";
import { applyLinkTracking } from "@/lib/sms/links";
import { unsupportedMergeFields } from "@/lib/sms/render";
import { sendAtForZonedSlot } from "@/lib/sms/schedule";
import { getTemplate } from "@/lib/templates/repo";

/**
 * SMS campaigns collection API. Group-gated SERVER-SIDE on the Cognito
 * `marketing` group (via `requireUser`); the service-role Supabase client is
 * only reached through the repos. POST snapshots everything at creation time:
 * the template body, the computed 11:30 AM America/New_York send instant, and
 * the audience of the chosen contact list — a linked Monday board fetched
 * live (every page), or an uploaded sheet's stored members — classified into
 * outbox rows.
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
  // Per-user client (RLS `authenticated` role) when SUPABASE_JWT_SECRET is
  // set; the service-role fallback otherwise — identical to before.
  const db = await getUserClient(user);

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
  const template = await getTemplate(input.templateId, db);
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

  const sendAt = sendAtForZonedSlot(
    input.sendDate,
    input.sendTime,
    input.sendTimezone,
  );
  if (sendAt.getTime() <= Date.now()) {
    return Response.json(
      { error: "The chosen send slot is already in the past" },
      { status: 400 },
    );
  }

  const list = await getContactList(input.contactListId, db);
  if (!list) {
    return Response.json({ error: "Contact list not found" }, { status: 400 });
  }

  // Idempotency backstop BEFORE the (slow) audience fetch: the same template +
  // list + send date still live means a double-submit, not a new campaign.
  const duplicate = await findActiveDuplicateCampaign(
    input.templateId,
    input.contactListId,
    input.sendDate,
    db,
  );
  if (duplicate) {
    return Response.json(
      { error: "duplicate-campaign", existingId: duplicate.id },
      { status: 409 },
    );
  }

  let sourceRows: SourceRecipientRow[];
  if (list.source === "monday") {
    // Every page of the board — a linked board is live membership.
    try {
      // Verify the board still exists: fetchBoardRecipients returns [] for an
      // unknown/deleted board, which would otherwise become an empty 201.
      const board = await getBoardMeta(list.monday_board_id!);
      if (!board) {
        return Response.json({ error: "board-not-found" }, { status: 404 });
      }
      sourceRows = await fetchBoardRecipients(
        list.monday_board_id!,
        list.monday_phone_column_id!,
      );
    } catch (err) {
      if (err instanceof MondayConfigError) {
        return Response.json({ error: "monday-not-configured" }, { status: 503 });
      }
      throw err;
    }
  } else {
    // Uploaded sheet: the parsed, already-classified members ARE the audience.
    const members = await getSendableMembers(list.id, db);
    sourceRows = members.map((m) => ({
      name: m.name,
      firstName: m.first_name,
      phoneE164: m.phone_e164,
      rawPhone: m.raw_phone,
    }));
  }

  const suppressed = await getSuppressedSet(
    sourceRows.map((r) => r.phoneE164),
    db,
  );
  let prepared = prepareRecipients(sourceRows, template.body, suppressed);

  // Tracked short links: rewrite URLs in every pending row's rendered_text to
  // `<base>/l/<slug>` so clicks are attributable per recipient. Env-gated —
  // SMS_LINK_BASE_URL unset means messages go out with their original URLs.
  const linkBase = process.env.SMS_LINK_BASE_URL?.trim();
  if (linkBase) {
    prepared = applyLinkTracking(prepared, linkBase);
  }

  // A campaign nothing would send from is a mistake, not a campaign.
  const counts = summarize(prepared);
  if (counts.pending === 0) {
    return Response.json(
      {
        error:
          `Nothing would send: ${counts.pending} pending, ` +
          `${counts.skipped} skipped, ${counts.suppressed} suppressed ` +
          `of ${counts.total} audience rows`,
        counts,
      },
      { status: 400 },
    );
  }

  const campaign = await createCampaign(
    input,
    {
      mondayBoardId: list.source === "monday" ? list.monday_board_id : null,
      mondayPhoneColumnId:
        list.source === "monday" ? list.monday_phone_column_id : null,
    },
    template.body,
    prepared,
    { email: user.email },
    db,
  );

  return Response.json({ id: campaign.id, counts }, { status: 201 });
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const campaigns = await listCampaignsWithCounts(db);
  return Response.json({ campaigns });
}
