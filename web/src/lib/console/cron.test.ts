// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn() }));

vi.mock("./pgmeta", () => ({ runQuery: h.runQuery }));

import {
  listCronJobs,
  listCronRuns,
  scheduleCronJob,
  unscheduleCronJob,
} from "./cron";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("readers", () => {
  test("listCronJobs maps the catalog shape", async () => {
    h.runQuery.mockResolvedValue([
      {
        jobid: "3",
        jobname: "nightly",
        schedule: "0 3 * * *",
        command: "select 1",
        active: true,
        database: "postgres",
        username: "postgres",
        nodename: "localhost",
        nodeport: 5432,
      },
    ]);
    const jobs = await listCronJobs();
    expect(jobs[0]).toMatchObject({ jobid: 3, jobname: "nightly", active: true });
  });

  test("listCronRuns scopes by a validated jobid and caps the limit", async () => {
    h.runQuery.mockResolvedValue([]);
    await listCronRuns({ jobid: 7, limit: 9999 });
    const sql = lastSql();
    expect(sql).toContain("where jobid = 7");
    expect(sql).toContain("limit 500");
  });

  test("listCronRuns rejects a non-integer jobid", async () => {
    await expect(listCronRuns({ jobid: 1.2 })).rejects.toThrow(/invalid jobid/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("scheduleCronJob", () => {
  test("passes name/schedule/command as quoted literals", async () => {
    h.runQuery.mockResolvedValue([{ jobid: 42 }]);
    const id = await scheduleCronJob({
      name: "refresh-mv",
      schedule: "*/5 * * * *",
      command: "refresh materialized view marketinghub.mv",
    });
    expect(id).toBe(42);
    expect(lastSql()).toBe(
      "select cron.schedule('refresh-mv', '*/5 * * * *', 'refresh materialized view marketinghub.mv') as jobid",
    );
  });

  test("escapes a quote in the command (no SQL break-out)", async () => {
    h.runQuery.mockResolvedValue([{ jobid: 1 }]);
    await scheduleCronJob({
      name: "j",
      schedule: "0 0 * * *",
      command: "select 'a'",
    });
    expect(lastSql()).toContain("'select ''a'''");
  });

  test("rejects an empty name", async () => {
    await expect(
      scheduleCronJob({ name: "", schedule: "* * * * *", command: "select 1" }),
    ).rejects.toThrow(/\[console:cron\] schedule failed/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("unscheduleCronJob", () => {
  test("unschedules by validated integer jobid", async () => {
    h.runQuery.mockResolvedValue([{ unscheduled: true }]);
    expect(await unscheduleCronJob(42)).toBe(true);
    expect(lastSql()).toBe("select cron.unschedule(42) as unscheduled");
  });

  test("rejects a non-integer jobid", async () => {
    await expect(unscheduleCronJob(3.14)).rejects.toThrow(/invalid jobid/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});
