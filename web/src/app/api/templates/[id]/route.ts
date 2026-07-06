import { AuthError, requireUser } from "@/lib/auth";
import { getTemplate } from "@/lib/templates/repo";

/**
 * Single-template API. Group-gated server-side on the Cognito `marketing`
 * group, like the collection route. Returns 404 for an unknown id.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

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
  const template = await getTemplate(id);
  if (!template) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }
  return Response.json({ template });
}
