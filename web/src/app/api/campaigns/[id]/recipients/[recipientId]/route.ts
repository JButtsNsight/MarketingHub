import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import {
  getCampaign,
  markRecipientFailed,
  retryRecipient,
} from "@/lib/sms/repo";

/**
 * Manual review of a single outbox row — the human lane for resolving
 * `failed_ambiguous` recipients (the dispatcher NEVER auto-retries them):
 *
 * - `retry`       re-queue as due-now `pending`; the repo also re-opens a
 *                 `completed` campaign to `sending`, so the response carries
 *                 the campaign's fresh status for the UI to reflect.
 * - `mark_failed` declare the row terminally `failed` (optional audit note).
 *
 * A `null` repo result means the status guard lost (the row was not in a
 * reviewable state) → 409.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

const PatchBodySchema = z.object({
  action: z.enum(["retry", "mark_failed"]),
  /** Audit note stored as last_error by mark_failed. */
  note: z.string().trim().min(1).optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; recipientId: string }> },
): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
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

  const { recipientId } = await context.params;

  if (parsed.data.action === "retry") {
    const recipient = await retryRecipient(recipientId);
    if (!recipient) {
      return Response.json(
        { error: "Recipient is not in a retryable state" },
        { status: 409 },
      );
    }
    // retryRecipient may have re-opened the campaign (completed → sending) —
    // report its fresh status so the UI can reflect it without a refetch.
    const campaign = await getCampaign(recipient.campaign_id);
    return Response.json({
      recipient,
      campaignStatus: campaign?.status ?? null,
    });
  }

  const recipient = await markRecipientFailed(recipientId, parsed.data.note);
  if (!recipient) {
    return Response.json(
      { error: "Recipient is not awaiting manual review" },
      { status: 409 },
    );
  }
  return Response.json({ recipient });
}
