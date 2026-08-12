import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  classifySql,
  listHistory,
  ReadOnlyViolationError,
  runConsoleQuery,
} from "@/lib/console/sql";

/**
 * SQL editor execution + history, gated on the platform section.
 *
 * pg-meta runs everything as supabase_admin, so this route is the console's
 * most powerful surface. The write-confirm handshake is the guard the owner
 * chose: a statement the classifier cannot prove read-only 409s with
 * `requiresConfirmation` until the client re-submits with `confirmWrite` —
 * one explicit second step, no approval ceremony. Every run (success or
 * error) lands in console_query_history with who/what/when.
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

const PostBodySchema = z.object({
  sql: z.string().trim().min(1, "sql is required").max(100_000),
  confirmWrite: z.boolean().optional(),
});

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

  const classification = classifySql(parsed.data.sql);
  const confirmWrite = parsed.data.confirmWrite === true;

  // Up-front confirm for anything the classifier already knows writes.
  if (classification === "write" && !confirmWrite) {
    return Response.json(
      {
        requiresConfirmation: true,
        classification,
        error:
          "This statement modifies the database (or could not be proven read-only). Re-run with confirmation.",
      },
      { status: 409 },
    );
  }

  try {
    const result = await runConsoleQuery(
      parsed.data.sql,
      user.email,
      confirmWrite,
    );
    return Response.json(result);
  } catch (err) {
    // A `read`-classified statement that actually wrote (EXPLAIN ANALYZE DML,
    // SELECT INTO, side-effect function) aborted in the read-only txn — same
    // confirm handshake as an up-front write classification.
    if (err instanceof ReadOnlyViolationError) {
      return Response.json(
        {
          requiresConfirmation: true,
          classification: "write",
          error:
            "This statement modifies the database (or could not be proven read-only). Re-run with confirmation.",
        },
        { status: 409 },
      );
    }
    // Postgres errors are the editor's normal feedback loop — 400 with the
    // real message (already recorded in history by runConsoleQuery).
    if (err instanceof Error && err.message.startsWith("[console:pgmeta]")) {
      return Response.json(
        {
          error: err.message.replace(/^\[console:pgmeta\] query failed: /, ""),
          classification,
        },
        { status: 400 },
      );
    }
    throw err;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const history = await listHistory();
  return Response.json({ history });
}
