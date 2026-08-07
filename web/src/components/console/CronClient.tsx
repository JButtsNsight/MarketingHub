"use client";

import { useCallback, useState } from "react";

import { DataTable, type Column } from "@/components/ui/DataTable";
import { Section } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Badge } from "@/components/ui/Badge";
import { useConfirm } from "@/components/ui/AlertDialog";
import type { CronJob, CronRun } from "@/lib/console/cron";

/**
 * The Cron integration screen (pg_cron parity), MarketingHub-style. Reads —
 * the job catalog and recent run history — flow straight through the group-
 * gated /api/console/cron GET and need no confirmation. The two WRITES that
 * pg_cron exposes (schedule / unschedule) are DDL-ish and irreversible, so
 * each is put behind the interrupting confirm modal (useConfirm) — the guard
 * sits on the write, not on browsing.
 *
 * Scheduling by name is an UPSERT in pg_cron, so the confirm copy calls out
 * that an existing job with the same name is replaced.
 */

function truncate(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** pg_cron run statuses → tone. Red is reserved for a real failure. */
function statusTone(status: string): string | undefined {
  switch (status.toLowerCase()) {
    case "succeeded":
      return "var(--ok)";
    case "failed":
      return "var(--fail)";
    case "running":
    case "starting":
    case "sending":
      return "var(--warn)";
    default:
      return undefined;
  }
}

export function CronClient({
  initialJobs,
  initialRuns,
}: {
  initialJobs: CronJob[];
  initialRuns: CronRun[];
}) {
  const [jobs, setJobs] = useState(initialJobs);
  const [runs, setRuns] = useState(initialRuns);
  // null = run history spans all jobs; a jobid = scoped to that job.
  const [runsJobId, setRunsJobId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", schedule: "", command: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const refresh = useCallback(async (jobid: number | null = null) => {
    try {
      const params = new URLSearchParams();
      if (jobid != null) params.set("jobid", String(jobid));
      const res = await fetch(`/api/console/cron?${params.toString()}`);
      const body = (await res.json().catch(() => null)) as
        | { jobs?: CronJob[]; runs?: CronRun[]; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Loading cron data failed.");
        return;
      }
      setJobs(body?.jobs ?? []);
      setRuns(body?.runs ?? []);
      setRunsJobId(jobid);
      setError(null);
    } catch {
      setError("Network error — please try again.");
    }
  }, []);

  const scheduleJob = async () => {
    const name = form.name.trim();
    const schedule = form.schedule.trim();
    const command = form.command.trim();
    if (!name || !schedule || !command) {
      setError("Name, schedule, and command are all required.");
      return;
    }
    // WRITE — interrupt before creating/replacing a job.
    const ok = await confirm({
      title: "Schedule this job?",
      message: `pg_cron will run this command on the schedule "${schedule}" as job "${name}". Scheduling by name REPLACES any existing job with the same name.`,
      confirmLabel: "Schedule job",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/cron", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, schedule, command }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Scheduling the job failed.");
        return;
      }
      setForm({ name: "", schedule: "", command: "" });
      await refresh(runsJobId);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const unscheduleJob = async (job: CronJob) => {
    const label = job.jobname ?? `job ${job.jobid}`;
    // WRITE — interrupt before removing a schedule.
    const ok = await confirm({
      title: `Unschedule ${label}?`,
      message: `This removes the pg_cron schedule (${job.schedule}) for "${label}". It stops running immediately; bringing it back requires re-creating the job.`,
      confirmLabel: "Unschedule",
    });
    if (!ok) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/cron", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobid: job.jobid }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? "Unscheduling the job failed.");
        return;
      }
      // If runs were scoped to the job we just removed, widen back to all jobs.
      await refresh(runsJobId === job.jobid ? null : runsJobId);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const jobColumns: Column<CronJob>[] = [
    { key: "jobid", header: "id", mono: true, width: "64px" },
    {
      key: "jobname",
      header: "name",
      mono: true,
      render: (j) => j.jobname ?? "—",
    },
    { key: "schedule", header: "schedule", mono: true, width: "140px" },
    {
      key: "command",
      header: "command",
      mono: true,
      render: (j) => <span title={j.command}>{truncate(j.command)}</span>,
    },
    { key: "nodename", header: "node", mono: true, width: "130px" },
    {
      key: "active",
      header: "active",
      width: "92px",
      render: (j) =>
        j.active ? (
          <Badge tone="var(--ok)">active</Badge>
        ) : (
          <Badge>paused</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "170px",
      render: (j) => (
        <span className="cron-actions">
          <button
            type="button"
            className="type-chip"
            onClick={() => void refresh(j.jobid)}
          >
            Runs
          </button>
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => void unscheduleJob(j)}
          >
            Unschedule
          </button>
        </span>
      ),
    },
  ];

  const runColumns: Column<CronRun>[] = [
    { key: "runid", header: "run", mono: true, width: "72px" },
    { key: "jobid", header: "job", mono: true, width: "64px" },
    {
      key: "status",
      header: "status",
      width: "116px",
      render: (r) => <Badge tone={statusTone(r.status)}>{r.status || "—"}</Badge>,
    },
    {
      key: "startTime",
      header: "start",
      mono: true,
      render: (r) => r.startTime ?? "—",
    },
    {
      key: "endTime",
      header: "end",
      mono: true,
      render: (r) => r.endTime ?? "—",
    },
    {
      key: "returnMessage",
      header: "message",
      mono: true,
      render: (r) => {
        const text = r.returnMessage ?? "—";
        return <span title={text}>{truncate(text)}</span>;
      },
    },
  ];

  const activeCount = jobs.filter((j) => j.active).length;
  const failedCount = runs.filter((r) => r.status.toLowerCase() === "failed").length;

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Jobs" value={jobs.length} accent="var(--data-3)" />
        <StatCard
          label="Active"
          value={activeCount}
          hint={`of ${jobs.length}`}
          accent="var(--data-2)"
        />
        {/* No accent: a failed run is an attention state, not a data point. */}
        <StatCard
          label="Failed runs"
          value={failedCount}
          hint={runsJobId != null ? `job ${runsJobId}` : "in shown history"}
        />
        <StatCard label="Runs shown" value={runs.length} accent="var(--data-1)" />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="Schedule"
        title="New cron job"
        description="cron.schedule(name, schedule, command). Scheduling by an existing name replaces that job."
      >
        <div className="cron-form">
          <div className="field">
            <label htmlFor="cron-name">name</label>
            <input
              id="cron-name"
              className="surface control mono"
              type="text"
              placeholder="refresh-mv"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="cron-schedule">schedule</label>
            <input
              id="cron-schedule"
              className="surface control mono"
              type="text"
              placeholder="*/5 * * * *"
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="cron-command">command</label>
            <input
              id="cron-command"
              className="surface control mono"
              type="text"
              placeholder="select cron.schedule(...)  /  select pgmq.send(...)"
              value={form.command}
              onChange={(e) => setForm({ ...form, command: e.target.value })}
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => void scheduleJob()}
            >
              Schedule job
            </button>
          </div>
        </div>
      </Section>

      <Section eyebrow="Jobs" title="Scheduled jobs">
        <DataTable
          columns={jobColumns}
          rows={jobs}
          getRowKey={(j) => String(j.jobid)}
          empty="No cron jobs scheduled."
        />
      </Section>

      <Section
        eyebrow="Runs"
        title="Recent runs"
        actions={
          runsJobId != null ? (
            <button
              type="button"
              className="type-chip"
              onClick={() => void refresh(null)}
            >
              Show all jobs
            </button>
          ) : undefined
        }
      >
        <DataTable
          columns={runColumns}
          rows={runs}
          getRowKey={(r) => String(r.runid)}
          empty="No run history."
        />
      </Section>

      {dialog}
    </div>
  );
}

export default CronClient;
