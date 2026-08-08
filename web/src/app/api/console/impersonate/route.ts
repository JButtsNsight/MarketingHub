import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import {
  ImpersonationAuditError,
  runImpersonatedQuery,
} from "@/lib/console/impersonate";

/**
 * User Impersonation execution, gated on the Cognito `marketing` group (same
 * gate as every console route).
 *
 * The handler mints a bounded user JWT (role `authenticated` ONLY — the body
 * schema is strict, so a smuggled `role` key is a 400, and the lib re-verifies
 * the minted claims before running anything), executes the select as that
 * identity AND as service_role, and audits the run. The confirm handshake
 * mirrors the SQL editor: a request without `confirm: true` 409s with
 * `requiresConfirmation` — one explicit second step, no approval ceremony.
 * The raw JWT is never part of the response.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

// Strict: unknown keys (e.g. an attempted `role` override) fail validation.
const PostBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    groups: z
      .array(z.string().trim().min(1).max(64))
      .max(16)
      .default(["marketing"]),
    ttlSeconds: z.number().int().min(60).max(900).default(300),
    schema: z.literal("marketinghub"),
    table: z
      .string()
      .regex(
        /^[a-z_][a-z0-9_]*$/,
        "table must be a lowercase snake_case identifier",
      )
      .max(63),
    limit: z.number().int().min(1).max(100).default(20),
    returnToken: z.boolean().optional(),
    confirm: z.literal(true).optional(),
  })
  .strict();

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

  // Explicit confirm handshake before any token is minted.
  if (parsed.data.confirm !== true) {
    return Response.json(
      {
        requiresConfirmation: true,
        error:
          "Impersonation mints a real (bounded, authenticated-role) credential " +
          "and runs a query as that identity. Re-submit with confirmation.",
      },
      { status: 409 },
    );
  }

  try {
    const result = await runImpersonatedQuery(user.email, {
      email: parsed.data.email,
      groups: parsed.data.groups,
      ttlSeconds: parsed.data.ttlSeconds,
      schema: parsed.data.schema,
      table: parsed.data.table,
      limit: parsed.data.limit,
      returnToken: parsed.data.returnToken,
    });
    return Response.json(result);
  } catch (err) {
    // The audit row is mandatory: results never leave without one.
    if (err instanceof ImpersonationAuditError) {
      return Response.json({ error: err.message }, { status: 500 });
    }
    // Wave-4 flag unset — impersonation has nothing to mint with.
    if (err instanceof Error && err.message.includes("SUPABASE_JWT_SECRET")) {
      return Response.json(
        {
          error:
            "SUPABASE_JWT_SECRET is unset — user impersonation requires the " +
            "Wave-4 user-JWT flag.",
        },
        { status: 503 },
      );
    }
    throw err;
  }
}
