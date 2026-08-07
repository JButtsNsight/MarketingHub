import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { runAdvisors, type AdvisorLevel } from "@/lib/console/advisors";

/**
 * Supabase-parity Advisors: runs the fixed security + performance lint suite
 * (postgres catalog reads only) and returns the findings, gated on the
 * `marketing` Cognito group.
 *
 * READ-ONLY — the only verb is GET; nothing here mutates state, so there is no
 * write to put behind a confirm. The lint SQL is a module constant in the
 * foundation lib (no user input reaches SQL), so `level` is the sole input and
 * is validated to the two known levels. `[console:*]` failures surface as 400s
 * with pg-meta's real message, exactly like /api/console/rows.
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Foundation-lib failures (`[console:<area>] <op> failed: <msg>`) are 400s. */
async function consoleAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:")) {
      return Response.json(
        {
          error: err.message.replace(
            /^\[console:[\w-]+\] (?:[\w-]+ failed: )?/,
            "",
          ),
        },
        { status: 400 },
      );
    }
    throw err;
  }
}

const LevelSchema = z.enum(["security", "performance"]);

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  // Optional `level` filter. Absent / empty / "all" runs the full suite; any
  // other value must be one of the two known levels or it is a 400.
  const raw = new URL(req.url).searchParams.get("level");
  let level: AdvisorLevel | undefined;
  if (raw != null && raw !== "" && raw !== "all") {
    const parsed = LevelSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "level must be 'security', 'performance', or 'all'" },
        { status: 400 },
      );
    }
    level = parsed.data;
  }

  const report = await consoleAttempt(() => runAdvisors(level));
  if (report instanceof Response) return report;
  return Response.json(report);
}
