import { AuthError, requireUser } from "@/lib/auth";
import { normalizeUsPhone } from "@/lib/sms/phone";
import { getSuppression, removeManualSuppression } from "@/lib/sms/repo";

/**
 * Remove one MANUAL suppression entry. Webhook 'stop' entries are permanent —
 * the person texted STOP, and only the carrier-side re-subscribe flow may
 * bring them back — so those 409 here. The removal is audited (who/when) in
 * sms_suppression_audit.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ phone: string }> },
): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const { phone: rawPhone } = await context.params;
  const phone = normalizeUsPhone(decodeURIComponent(rawPhone));
  if (!phone) {
    return Response.json({ error: "Suppression not found" }, { status: 404 });
  }

  const existing = await getSuppression(phone);
  if (!existing) {
    return Response.json({ error: "Suppression not found" }, { status: 404 });
  }
  if (existing.reason !== "manual") {
    return Response.json(
      {
        error:
          "STOP entries are permanent — the person opted out by text and " +
          "only re-subscribing through the carrier flow can bring them back",
      },
      { status: 409 },
    );
  }

  const removed = await removeManualSuppression(phone, user.email);
  if (!removed) {
    // Lost a race with a concurrent removal (or a reason flip) — the guard
    // owns the truth.
    return Response.json({ error: "Suppression not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
