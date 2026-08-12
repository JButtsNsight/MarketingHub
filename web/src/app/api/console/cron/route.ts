import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  listCronJobs,
  listCronRuns,
  scheduleCronJob,
  unscheduleCronJob,
} from "@/lib/console/cron";

/**
 * pg_cron control surface (Studio → Integrations → Cron), gated on the Cognito
 * platform section. GET reads the job catalog + recent run history (optionally
 * scoped to one job); POST schedules/replaces a job via `cron.schedule`; DELETE
 * unschedules via `cron.unschedule`.
 *
 * The data layer (`@/lib/console/cron`) is the ONLY thing that touches SQL — it
 * passes name/schedule/command as `quote_literal` text and validates every id
 * as a safe integer, so nothing user-supplied is ever spliced as SQL. pg_cron
 * failures (a malformed schedule, a bad name) are user errors here, so the
 * `[console:cron]` prefix maps to a 400 with the real message — exactly how
 * /api/console/rows surfaces `[console:tables]` errors.
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** pg_cron-level failures are user feedback on this surface — surface as 400. */
async function cronAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:cron]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:cron\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

// `name`/`schedule`/`command` are pg_cron TEXT arguments (never SQL) — the data
// layer re-checks the same length caps, this is the up-front reject.
const ScheduleSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(128),
  schedule: z.string().trim().min(1, "schedule is required").max(4000),
  command: z.string().trim().min(1, "command is required").max(4000),
});

const UnscheduleSchema = z.object({
  jobid: z.number().int().nonnegative().safe(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);

  let jobid: number | undefined;
  const rawJobId = url.searchParams.get("jobid");
  if (rawJobId !== null) {
    const n = Number(rawJobId);
    if (!Number.isSafeInteger(n) || n < 0) {
      return Response.json(
        { error: "jobid must be a non-negative integer" },
        { status: 400 },
      );
    }
    jobid = n;
  }

  // The data layer clamps the limit into [1, MAX_RUN_LIMIT]; a bad value just
  // falls back to the default, so no separate validation is needed here.
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null ? Number(rawLimit) : undefined;

  const result = await cronAttempt(async () => {
    const [jobs, runs] = await Promise.all([
      listCronJobs(),
      listCronRuns({ jobid, limit }),
    ]);
    return { jobs, runs };
  });
  if (result instanceof Response) return result;
  return Response.json(result);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ScheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const jobid = await cronAttempt(() => scheduleCronJob(parsed.data));
  if (jobid instanceof Response) return jobid;
  return Response.json({ jobid }, { status: 201 });
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = UnscheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const unscheduled = await cronAttempt(() =>
    unscheduleCronJob(parsed.data.jobid),
  );
  if (unscheduled instanceof Response) return unscheduled;
  if (!unscheduled) {
    return Response.json({ error: "No job with that id" }, { status: 404 });
  }
  return Response.json({ unscheduled: true });
}
