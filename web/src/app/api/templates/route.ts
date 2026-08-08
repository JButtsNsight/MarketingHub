import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import {
  createTemplate,
  listTemplates,
  searchTemplates,
  type ListFilters,
  type TemplateFile,
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

/** Map a filename extension to the content type stored with the upload. */
function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "html") return "text/html";
  if (ext === "eml") return "message/rfc822";
  return "text/plain";
}

/**
 * If the request carried a `filename`, package the (already-validated) body as
 * a raw file so `createTemplate` persists it to Storage. The metadata body and
 * the stored file are the same content — the file is the downloadable artifact.
 */
function fileFrom(payload: unknown, body: string): TemplateFile | undefined {
  const filename =
    payload && typeof (payload as { filename?: unknown }).filename === "string"
      ? (payload as { filename: string }).filename
      : null;
  if (!filename) return undefined;
  return { filename, content: body, contentType: contentTypeFor(filename) };
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

  const parsed = TemplateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Per-user client (RLS `authenticated` role) when SUPABASE_JWT_SECRET is
  // set; the service-role fallback otherwise — identical to before.
  const db = await getUserClient(user);
  const file = fileFrom(payload, parsed.data.body);
  const template = await createTemplate(
    parsed.data,
    { email: user.email },
    file,
    db,
  );
  return Response.json({ id: template.id, template }, { status: 201 });
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const filters: ListFilters = {
    category: url.searchParams.get("category") ?? undefined,
    type: coerceType(url.searchParams.get("type")),
  };

  const results = q
    ? await searchTemplates(q, filters, db)
    : await listTemplates(filters, db);

  return Response.json({ results });
}
