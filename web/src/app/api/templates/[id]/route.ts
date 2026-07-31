import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { getTemplate, updateTemplate } from "@/lib/templates/repo";
import { TemplateUpdateSchema } from "@/lib/templates/schema";

/**
 * Single-template API. Group-gated server-side on the Cognito `marketing`
 * group, like the collection route. Returns 404 for an unknown id. PATCH
 * edits content/metadata (type is immutable — see updateTemplate).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

/**
 * Path params reach PostgREST as uuid filters — a non-UUID would trigger
 * Postgres 22P02 (thrown → 500). Guard up front: not a UUID = not found.
 */
const UuidSchema = z.string().uuid();

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
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }
  const template = await getTemplate(id);
  if (!template) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }
  return Response.json({ template });
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
  if (!UuidSchema.safeParse(id).success) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TemplateUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let template;
  try {
    template = await updateTemplate(id, parsed.data);
  } catch (err) {
    // The repo's email-subject guard is a caller mistake, not a server fault.
    if (err instanceof Error && err.message.includes("subject is required")) {
      return Response.json(
        { error: "subject is required for email templates" },
        { status: 400 },
      );
    }
    throw err;
  }
  if (!template) {
    return Response.json({ error: "Template not found" }, { status: 404 });
  }
  return Response.json({ template });
}
