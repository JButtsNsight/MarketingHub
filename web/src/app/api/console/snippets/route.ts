import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { createSnippet, listSnippets } from "@/lib/console/sql";

/** Saved SQL snippets (Studio's saved queries), shared across the group. */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

const PostBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200),
  sql: z.string().trim().min(1, "sql is required").max(100_000),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }
  const snippets = await listSnippets();
  return Response.json({ snippets });
}

export async function POST(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireSectionApi(req.headers, "platform");
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

  const snippet = await createSnippet(
    parsed.data.name,
    parsed.data.sql,
    user.email,
  );
  return Response.json({ snippet }, { status: 201 });
}
