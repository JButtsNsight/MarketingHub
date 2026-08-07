import "server-only";

import { runQuery } from "./pgmeta";
import { assertSafeInteger, clampLimit, quoteLiteral } from "./identifiers";

/**
 * pg_cron data layer — the console's parity for Studio's "Cron" integration.
 * Jobs live in `cron.job`; run history in `cron.job_run_details`.
 *
 * Scheduling goes through `cron.schedule(name, schedule, command)` and
 * unscheduling through `cron.unschedule(jobid)`. Every value crossing into SQL
 * is either a validated integer (`jobid`, `limit`) or a `quote_literal` string
 * (`name`, `schedule`, `command`) — pg_cron takes those as plain text
 * arguments, so nothing is ever parsed back as SQL. Scheduling by name is an
 * UPSERT in pg_cron: an existing job with the same name is replaced.
 */

function fail(op: string, message: string): never {
  throw new Error(`[console:cron] ${op} failed: ${message}`);
}

/** Runs history is bounded — the page paginates, it does not stream years. */
export const DEFAULT_RUN_LIMIT = 50;
export const MAX_RUN_LIMIT = 500;
/** pg_cron job/schedule/command length caps (defensive; DB has its own). */
const MAX_JOBNAME_LEN = 128;
const MAX_FIELD_LEN = 4000;

export interface CronJob {
  jobid: number;
  jobname: string | null;
  schedule: string;
  command: string;
  active: boolean;
  database: string;
  username: string;
  nodename: string;
  nodeport: number;
}

export async function listCronJobs(): Promise<CronJob[]> {
  const rows = await runQuery(
    `select jobid::int8 as jobid,
            jobname,
            schedule,
            command,
            active,
            database,
            username,
            nodename,
            nodeport
       from cron.job
      order by jobid`,
  );
  return rows.map((r) => ({
    jobid: Number(r.jobid),
    jobname: (r.jobname as string | null) ?? null,
    schedule: String(r.schedule ?? ""),
    command: String(r.command ?? ""),
    active: r.active === true,
    database: String(r.database ?? ""),
    username: String(r.username ?? ""),
    nodename: String(r.nodename ?? ""),
    nodeport: Number(r.nodeport ?? 0),
  }));
}

export interface CronRun {
  runid: number;
  jobid: number;
  jobPid: number | null;
  database: string;
  username: string;
  command: string;
  status: string;
  returnMessage: string | null;
  startTime: string | null;
  endTime: string | null;
}

/** Recent run history, newest first; optionally scoped to one job. */
export async function listCronRuns(
  opts: { jobid?: number; limit?: number } = {},
): Promise<CronRun[]> {
  const limit = clampLimit(opts.limit, DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT);
  let where = "";
  if (opts.jobid !== undefined) {
    const jobid = assertSafeInteger(opts.jobid, "jobid");
    where = `where jobid = ${jobid}`;
  }
  const rows = await runQuery(
    `select runid::int8 as runid,
            jobid::int8 as jobid,
            job_pid,
            database,
            username,
            command,
            status,
            return_message,
            start_time::text as start_time,
            end_time::text as end_time
       from cron.job_run_details
       ${where}
      order by start_time desc nulls last
      limit ${limit}`,
  );
  return rows.map((r) => ({
    runid: Number(r.runid),
    jobid: Number(r.jobid),
    jobPid: r.job_pid == null ? null : Number(r.job_pid),
    database: String(r.database ?? ""),
    username: String(r.username ?? ""),
    command: String(r.command ?? ""),
    status: String(r.status ?? ""),
    returnMessage: (r.return_message as string | null) ?? null,
    startTime: (r.start_time as string | null) ?? null,
    endTime: (r.end_time as string | null) ?? null,
  }));
}

/**
 * Schedule (or replace, by name) a cron job. Returns the resulting jobid.
 * `name`/`schedule`/`command` are pg_cron text arguments passed as
 * `quote_literal`s — never spliced as SQL.
 */
export async function scheduleCronJob(opts: {
  name: string;
  schedule: string;
  command: string;
}): Promise<number> {
  const { name, schedule, command } = opts;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_JOBNAME_LEN) {
    fail("schedule", `job name must be 1-${MAX_JOBNAME_LEN} chars`);
  }
  if (typeof schedule !== "string" || schedule.length === 0 || schedule.length > MAX_FIELD_LEN) {
    fail("schedule", "schedule must be a non-empty string");
  }
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_FIELD_LEN) {
    fail("schedule", "command must be a non-empty string");
  }
  const rows = await runQuery(
    `select cron.schedule(${quoteLiteral(name)}, ${quoteLiteral(schedule)}, ${quoteLiteral(command)}) as jobid`,
  );
  const jobid = rows[0]?.jobid;
  if (jobid == null) fail("schedule", "pg_cron did not return a jobid");
  return Number(jobid);
}

/** Unschedule a job by id. Returns whether pg_cron confirmed the removal. */
export async function unscheduleCronJob(jobid: number): Promise<boolean> {
  const id = assertSafeInteger(jobid, "jobid");
  const rows = await runQuery(`select cron.unschedule(${id}) as unscheduled`);
  return rows[0]?.unscheduled === true;
}
