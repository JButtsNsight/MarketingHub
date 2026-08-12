import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { readJsonBodyBounded } from "@/lib/jsonBody";
import { getUserClient } from "@/lib/supabase";
import {
  createSource,
  listSources,
  listSourceStats,
  NotProvisionedError,
} from "@/lib/intel/repo";
import { SourceCreateInputSchema } from "@/lib/intel/schema";

/**
 * Competitor-intel sources collection. Gated SERVER-SIDE on the Cognito
 * intel section via `requireSectionApi` (ALB-injected `x-amzn-oidc-data`), like
 * every app route. All DB access goes through the user client so RLS applies.
 *
 * Note: `url` on a source is reference metadata ONLY — nothing here fetches
 * it (URL ingestion is a follow-up pending SSRF guardrails).
 */

// Reads request-time headers (ALB identity); never prerender/cache.
export const dynamic = "force-dynamic";

/** Map an AuthError to its HTTP response; rethrow anything else. */
function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Honest 503 while the competitor_intel substrate is not applied yet. */
function notProvisionedResponse(err: NotProvisionedError): Response {
  return Response.json(
    { error: "intel-not-provisioned", message: err.message },
    { status: 503 },
  );
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }
  const db = await getUserClient(user);

  try {
    const [sources, stats] = await Promise.all([
      listSources(db),
      listSourceStats(db),
    ]);
    return Response.json({ sources, stats });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "intel");
  } catch (err) {
    return authErrorResponse(err);
  }

  // Bounded read BEFORE parse (house guard: a bare req.json() buffers the
  // whole body before Zod runs — an OOM lever). The 256KB default dwarfs the
  // largest legitimate source payload (name 200 + url + notes 4000 chars).
  const read = await readJsonBodyBounded(req);
  if (!read.ok) return read.response;

  const parsed = SourceCreateInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = await getUserClient(user);
  try {
    const source = await createSource(parsed.data, db);
    return Response.json({ id: source.id, source }, { status: 201 });
  } catch (err) {
    if (err instanceof NotProvisionedError) return notProvisionedResponse(err);
    throw err;
  }
}
