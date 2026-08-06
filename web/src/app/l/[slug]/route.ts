import { getLinkTarget, recordLinkClick } from "@/lib/sms/repo";

/**
 * Public short-link redirect — the `/l/<slug>` URLs embedded in campaign SMS
 * bodies by tracked-link rewriting at creation time.
 *
 * NOT Cognito-gated: recipients click from their phones. In production the
 * ALB listener must bypass OIDC auth for `/l/*` exactly like it must for
 * `/api/webhooks/*` (both are blocked on the public front door landing).
 * There is nothing to protect here: an unknown slug 404s, a known slug leaks
 * only its own target URL.
 *
 * Click recording is best-effort — a storage hiccup must never break the
 * recipient's redirect.
 */

export const dynamic = "force-dynamic";

/** Slugs are app-generated base62; anything else is not worth a DB trip. */
const SLUG_SHAPE = /^[0-9A-Za-z]{4,32}$/;

export async function GET(
  req: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  if (!SLUG_SHAPE.test(slug)) {
    return new Response("Not found", { status: 404 });
  }

  const link = await getLinkTarget(slug);
  if (!link) {
    return new Response("Not found", { status: 404 });
  }

  try {
    await recordLinkClick(link.id, req.headers.get("user-agent"));
  } catch (err) {
    console.error("[sms] link click record failed:", err);
  }

  return Response.redirect(link.target_url, 302);
}
