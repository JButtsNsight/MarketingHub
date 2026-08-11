"use client";

import { useState } from "react";

import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Surface } from "../Surface";
import type {
  AdvisorLevel,
  AdvisorLint,
  AdvisorReport,
  AdvisorSeverity,
} from "@/lib/console/advisors";

/**
 * The interactive shell for the Advisors screen. It renders the initial
 * server-run report and lets the user re-run the suite or scope it to a single
 * advisor level (Security / Performance) — both through the group-gated
 * /api/console/advisors route. Findings are grouped by SEVERITY
 * (ERROR / WARN / INFO), most serious first (the lib pre-sorts them).
 *
 * READ-ONLY: nothing here mutates state, so there is no destructive action and
 * therefore no confirm modal — reads need no confirm.
 */

type LevelFilter = "all" | AdvisorLevel;

const LEVEL_FILTERS: Array<{ value: LevelFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "security", label: "Security" },
  { value: "performance", label: "Performance" },
];

/** Severity → house tone. ERROR uses the failure red (a lint error IS a
 *  failure state, the same call the RLS page makes for disabled RLS). */
const SEVERITY_TONE: Record<AdvisorSeverity, string | undefined> = {
  error: "var(--fail)",
  warn: "var(--warn)",
  info: undefined,
};

const SEVERITY_GROUPS: Array<{ severity: AdvisorSeverity; label: string }> = [
  { severity: "error", label: "Errors" },
  { severity: "warn", label: "Warnings" },
  { severity: "info", label: "Info" },
];

function truncated(text: string, max = 80) {
  const value = text && text.length > 0 ? text : "—";
  return (
    <span title={value}>
      {value.length > max ? `${value.slice(0, max - 1)}…` : value}
    </span>
  );
}

const FINDING_COLUMNS: Column<AdvisorLint>[] = [
  {
    key: "level",
    header: "type",
    width: "120px",
    render: (l) => (
      <Badge tone={l.level === "security" ? "var(--data-2)" : "var(--data-3)"}>
        {l.level}
      </Badge>
    ),
  },
  {
    key: "title",
    header: "lint",
    width: "240px",
    render: (l) => l.title,
  },
  {
    key: "object",
    header: "object",
    mono: true,
    width: "220px",
    render: (l) =>
      l.object
        ? l.schema
          ? `${l.schema}.${l.object}`
          : l.object
        : l.schema ?? "—",
  },
  {
    key: "detail",
    header: "detail",
    render: (l) => truncated(l.detail),
  },
  {
    key: "remediation",
    header: "remediation",
    render: (l) => truncated(l.remediation),
  },
];

const FAILED_COLUMNS: Column<{ id: string; error: string }>[] = [
  { key: "id", header: "check", mono: true, width: "260px" },
  { key: "error", header: "error", mono: true, render: (f) => truncated(f.error, 120) },
];

export function AdvisorsClient({ initialReport }: { initialReport: AdvisorReport }) {
  const [report, setReport] = useState(initialReport);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (next: LevelFilter) => {
    setLevel(next);
    setLoading(true);
    setError(null);
    try {
      const qs = next === "all" ? "" : `?level=${next}`;
      const res = await fetch(`/api/console/advisors${qs}`);
      const body = (await res.json().catch(() => null)) as
        | (AdvisorReport & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok) {
        setError((body as { error?: string })?.error ?? "Running advisors failed.");
        return;
      }
      setReport(body as AdvisorReport);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  };

  const counts: Record<AdvisorSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const lint of report.lints) counts[lint.severity] += 1;

  const hasFindings = report.lints.length > 0;

  return (
    <div className="stack">
      <div className="dgrid-toolbar" role="search">
        {LEVEL_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={level === f.value ? "type-chip on" : "type-chip"}
            aria-pressed={level === f.value}
            disabled={loading}
            onClick={() => {
              if (f.value !== level) void run(f.value);
            }}
          >
            {f.label}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className="type-chip"
          disabled={loading}
          onClick={() => void run(level)}
        >
          {loading ? "Running…" : "Re-run advisors"}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="stat-grid">
        {/* No accent: any error/warning lint is an attention state, and the
            design language reserves --fail for a StatCard-forbidden red. */}
        <StatCard label="Errors" value={counts.error} />
        <StatCard label="Warnings" value={counts.warn} />
        <StatCard label="Info" value={counts.info} accent="var(--data-2)" />
      </div>

      {report.failed.length > 0 ? (
        <Section
          eyebrow="Advisors"
          title="Checks that could not run"
          description="These lints failed to execute; the rest still ran."
        >
          <DataTable
            columns={FAILED_COLUMNS}
            rows={report.failed}
            getRowKey={(f) => f.id}
            empty="None."
          />
        </Section>
      ) : null}

      {hasFindings ? (
        SEVERITY_GROUPS.map((group) => {
          const lints = report.lints.filter((l) => l.severity === group.severity);
          if (lints.length === 0) return null;
          return (
            <Section
              key={group.severity}
              eyebrow="Advisors"
              title={`${group.label} (${lints.length})`}
              actions={
                <Badge tone={SEVERITY_TONE[group.severity]}>
                  {group.severity}
                </Badge>
              }
            >
              <DataTable
                columns={FINDING_COLUMNS}
                rows={lints}
                getRowKey={(l) => `${l.id}:${l.schema ?? ""}.${l.object ?? ""}`}
                empty="No findings."
              />
            </Section>
          );
        })
      ) : (
        <Surface className="empty-state" glint>
          <h2>No advisories</h2>
          <p>
            Every advisor check passed for the scanned schemas
            {level === "all" ? "" : ` at the ${level} level`}.
          </p>
        </Surface>
      )}
    </div>
  );
}

export default AdvisorsClient;
