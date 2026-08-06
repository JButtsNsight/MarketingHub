import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { normalizeUsPhone } from "@/lib/sms/phone";
import { addManualSuppression, listSuppressions } from "@/lib/sms/repo";

/**
 * STOP-list management API. GET lists (optionally digit-searched via `?q=`);
 * POST adds a MANUAL suppression — normalized to E.164 first, fanned out
 * across not-yet-attempted outbox rows, and audited (who/why) in
 * sms_suppression_audit. Webhook 'stop' entries never come through here.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

const PostBodySchema = z.object({
  phone: z.string().trim().min(1, "phone is required"),
  /** Why the number is being suppressed by hand — stored in the audit row. */
  note: z.string().trim().min(1).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const q = new URL(req.url).searchParams.get("q");
  const suppressions = await listSuppressions(
    q === null ? {} : { query: q },
  );
  return Response.json({ suppressions });
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

  const parsed = PostBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const phone = normalizeUsPhone(parsed.data.phone);
  if (!phone) {
    return Response.json(
      { error: "Not a usable US phone number" },
      { status: 400 },
    );
  }

  const { created, suppression } = await addManualSuppression(
    phone,
    user.email,
    parsed.data.note,
  );
  if (!created) {
    return Response.json(
      { error: "Phone is already suppressed", suppression },
      { status: 409 },
    );
  }
  return Response.json({ suppression }, { status: 201 });
}
