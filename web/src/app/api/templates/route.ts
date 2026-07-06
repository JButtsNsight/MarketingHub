import { AuthError, requireUser } from "@/lib/auth";
import {
  createTemplate,
  listTemplates,
  searchTemplates,
  type ListFilters,
} from "@/lib/templates/repo";
import { TemplateInputSchema, TEMPLATE_TYPES } from "@/lib/templates/schema";
import type { TemplateType } from "@/lib/templates/schema";

/**
 * Templates collection API. Every handler is gated SERVER-SIDE on the Cognito
 * `marketing` group (via `requireUser`, which reads the ALB-injected
 * `x-amzn-oidc-data` header). The browser never decides authz, and the
 * service-role Supabase client is only reached through `repo.ts` here.
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

/** Narrow an arbitrary query value to a valid TemplateType, else undefined. */
function coerceType(value: string | null): TemplateType | undefined {
  return (TEMPLATE_TYPES as readonly string[]).includes(value ?? "")
    ? (value as TemplateType)
    : undefined;
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = TemplateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const template = await createTemplate(parsed.data, { email: user.email });
  return Response.json({ id: template.id, template }, { status: 201 });
}

export async function GET(req: Request): Promise<Response> {
  try {
    requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const filters: ListFilters = {
    category: url.searchParams.get("category") ?? undefined,
    type: coerceType(url.searchParams.get("type")),
  };

  const results = q
    ? await searchTemplates(q, filters)
    : await listTemplates(filters);

  return Response.json({ results });
}
