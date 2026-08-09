import { AuthError, requireUser } from "@/lib/auth";
import { getUserClient } from "@/lib/supabase";
import { NotProvisionedError, searchChunks } from "@/lib/intel/repo";
import { SearchInputSchema } from "@/lib/intel/schema";
import {
  EmbeddingConfigError,
  EmbeddingProviderError,
} from "@/lib/intel/providers";

/**
 * Semantic search over competitor-intel chunks. The QUERY is embedded via the
 * env-selected provider (CI_EMBED_PROVIDER: default = deterministic stub with
 * ZERO AWS calls; 'bedrock' only under the staged activation), then ranked by
 * the `match_chunks` RPC (pgvector cosine, SECURITY INVOKER — RLS applies).
 *
 * The response is stub-honest: `provider` names the model that embedded the
 * query and `mismatchedModels` lists corpus models that differ, so the UI can
 * badge "similarity illustrative" states. Retrieval only — NO answer
 * synthesis, NO LLM calls (pending separate sign-off).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

export async function GET(req: Request): Promise<Response> {
  let user;
  try {
    user = await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const countRaw = url.searchParams.get("count");
  const sourceIdRaw = url.searchParams.get("sourceId");
  const parsed = SearchInputSchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    // Absent/blank params fall back to schema defaults (null / 8).
    sourceId: sourceIdRaw ? sourceIdRaw : null,
    count: countRaw ? countRaw : undefined,
  });
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = await getUserClient(user);
  try {
    const { provider, rows, mismatchedModels } = await searchChunks(
      parsed.data.q,
      { sourceId: parsed.data.sourceId, count: parsed.data.count },
      db,
    );
    return Response.json({
      query: parsed.data.q,
      provider,
      mismatchedModels,
      results: rows,
    });
  } catch (err) {
    if (err instanceof NotProvisionedError) {
      return Response.json(
        { error: "intel-not-provisioned", message: err.message },
        { status: 503 },
      );
    }
    if (err instanceof EmbeddingConfigError) {
      return Response.json(
        { error: "embedding-not-configured", message: err.message },
        { status: 503 },
      );
    }
    if (err instanceof EmbeddingProviderError) {
      return Response.json(
        { error: "embedding-failed", message: err.message },
        { status: 502 },
      );
    }
    throw err;
  }
}
