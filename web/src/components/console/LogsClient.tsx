"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Surface } from "../Surface";
import type { LogEntry } from "@/lib/console/logs";

/**
 * Logs explorer (Studio → Logs parity, Wave 6). READ-ONLY by design: every
 * control here only reshapes the query the group-gated /api/console/logs
 * route runs — source, fixed range preset, per-source severity pills, and a
 * free-text search the server binds as a LIKE literal. No user SQL exists on
 * this surface.
 *
 * Tail is a plain 10-second polling toggle (default off, paused while the
 * tab is hidden) — deliberately NOT a realtime socket; logs arrive through
 * Logflare's query endpoint only.
 *
 * When the route answers 503 + `unavailable` (the staged Wave-6 Kong route /
 * token apply is still pending), the table gives way to the honest
 * "Analytics unavailable" state instead of pretending the range is empty.
 */

/**
 * Serializable picker shape the server page derives from listSources()
 * (id + label + the severity allowlist; the lib's SQL expressions stay
 * server-side).
 */
export interface LogSourceOption {
  id: string;
  label: string;
  /** Severity allowlist; absent → the source has no severity filter to show. */
  severities?: readonly string[];
}

/** Fixed range presets — mirrors the route's PRESET_MS allowlist. */
const PRESETS = ["15m", "1h", "6h", "24h", "7d"] as const;
type Preset = (typeof PRESETS)[number];

/** Poll cadence for the Tail toggle. */
const TAIL_INTERVAL_MS = 10_000;

/** Level → house tone. Error-class levels ARE failure states → --fail. */
const LEVEL_TONE: Record<string, string> = {
  error: "var(--fail)",
  fatal: "var(--fail)",
  panic: "var(--fail)",
  warn: "var(--warn)",
  warning: "var(--warn)",
};

interface Filters {
  source: string;
  preset: Preset;
  severities: string[];
  search: string;
}

interface LogRow {
  key: string;
  entry: LogEntry;
}

function truncated(message: string, max = 180) {
  return (
    <span title={message}>
      {message.length > max ? `${message.slice(0, max - 1)}…` : message}
    </span>
  );
}

export function LogsClient({
  sources,
  initialEntries,
  initialError = null,
}: {
  sources: readonly LogSourceOption[];
  initialEntries: LogEntry[];
  initialError?: string | null;
}) {
  const [source, setSource] = useState(sources[0]?.id ?? "edge_logs");
  const [preset, setPreset] = useState<Preset>("1h");
  const [severities, setSeverities] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<LogEntry[]>(initialEntries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [unavailable, setUnavailable] = useState(false);
  const [tail, setTail] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const runQuery = async (filters: Filters) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        source: filters.source,
        preset: filters.preset,
      });
      if (filters.severities.length > 0) {
        params.set("severities", filters.severities.join(","));
      }
      const trimmed = filters.search.trim();
      if (trimmed !== "") params.set("search", trimmed);

      const res = await fetch(`/api/console/logs?${params.toString()}`);
      const body = (await res.json().catch(() => null)) as {
        entries?: LogEntry[];
        error?: string;
        unavailable?: boolean;
      } | null;

      if (res.status === 503 && body?.unavailable) {
        // Honest pre-apply state — never rendered as an empty range.
        setUnavailable(true);
        setEntries([]);
        setExpanded(new Set());
        return;
      }
      if (!res.ok || !body || !Array.isArray(body.entries)) {
        setError(body?.error ?? "Log query failed.");
        return;
      }
      setUnavailable(false);
      setEntries(body.entries);
      setExpanded(new Set());
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  };

  // The tail interval always polls with the CURRENT filters — a ref refreshed
  // each render avoids re-arming the timer on every filter change.
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    refreshRef.current = () => {
      void runQuery({ source, preset, severities, search });
    };
  });

  useEffect(() => {
    if (!tail) return;
    const id = window.setInterval(() => {
      // Paused while the tab is hidden — no point tailing an invisible table.
      if (document.hidden) return;
      refreshRef.current();
    }, TAIL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [tail]);

  const changeSource = (next: string) => {
    setSource(next);
    // Severity allowlists differ per source — never carry a stale filter over.
    setSeverities([]);
    void runQuery({ source: next, preset, severities: [], search });
  };

  const changePreset = (next: Preset) => {
    setPreset(next);
    void runQuery({ source, preset: next, severities, search });
  };

  const toggleSeverity = (value: string) => {
    const next = severities.includes(value)
      ? severities.filter((entry) => entry !== value)
      : [...severities, value];
    setSeverities(next);
    void runQuery({ source, preset, severities: next, search });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runQuery({ source, preset, severities, search });
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const activeSource = sources.find((entry) => entry.id === source);
  const severityValues = activeSource?.severities ?? [];

  const rows: LogRow[] = entries.map((entry, i) => ({
    key: `${i}:${entry.ts}`,
    entry,
  }));

  const columns: Column<LogRow>[] = [
    {
      key: "expand",
      header: "",
      width: "44px",
      render: (row) => {
        const isOpen = expanded.has(row.key);
        return (
          <button
            type="button"
            className="type-chip"
            aria-expanded={isOpen}
            aria-label={isOpen ? "Collapse metadata" : "Expand metadata"}
            onClick={() => toggleExpanded(row.key)}
          >
            {isOpen ? "−" : "+"}
          </button>
        );
      },
    },
    {
      key: "ts",
      header: "timestamp",
      mono: true,
      width: "190px",
      render: (row) => row.entry.ts || "—",
    },
    {
      key: "level",
      header: "level",
      width: "110px",
      render: (row) => (
        <Badge tone={LEVEL_TONE[row.entry.level]}>{row.entry.level}</Badge>
      ),
    },
    {
      key: "event",
      header: "event",
      render: (row) => {
        const isOpen = expanded.has(row.key);
        const message = row.entry.event || "—";
        return (
          <div>
            {isOpen ? <span>{message}</span> : truncated(message)}
            {isOpen ? (
              <pre
                className="code-pre mono"
                style={{ whiteSpace: "pre-wrap", paddingLeft: 0 }}
              >
                {JSON.stringify(row.entry.metadata ?? null, null, 2)}
              </pre>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack">
      <div className="dgrid-toolbar" role="toolbar" aria-label="Log query">
        <select
          className="surface control teditor-fctl"
          aria-label="Log source"
          value={source}
          disabled={loading}
          onChange={(event) => changeSource(event.target.value)}
        >
          {sources.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={preset === value ? "type-chip on" : "type-chip"}
            aria-pressed={preset === value}
            disabled={loading}
            onClick={() => {
              if (value !== preset) changePreset(value);
            }}
          >
            {value}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className={tail ? "type-chip on" : "type-chip"}
          aria-pressed={tail}
          title="Poll for new entries every 10 seconds (pauses while the tab is hidden)"
          onClick={() => setTail((prev) => !prev)}
        >
          {tail ? "Tail: on" : "Tail: off"}
        </button>
        <button
          type="button"
          className="type-chip"
          disabled={loading}
          onClick={() => void runQuery({ source, preset, severities, search })}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <form className="dgrid-toolbar" role="search" onSubmit={submitSearch}>
        {severityValues.map((value) => (
          <button
            key={value}
            type="button"
            className={severities.includes(value) ? "type-chip on" : "type-chip"}
            aria-pressed={severities.includes(value)}
            disabled={loading}
            onClick={() => toggleSeverity(value)}
          >
            {value}
          </button>
        ))}
        <span className="spacer" />
        <input
          className="surface control teditor-fctl"
          type="search"
          aria-label="Search event message"
          placeholder="Search event message"
          maxLength={200}
          value={search}
          disabled={loading}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button type="submit" className="type-chip" disabled={loading}>
          Search
        </button>
      </form>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {unavailable ? (
        <Surface className="empty-state" glint>
          <h2>Analytics unavailable</h2>
          <p>
            The Logflare analytics service did not answer through the data API
            — the staged Wave-6 enable (Kong analytics route + access token)
            has not been applied yet. Logs will appear here once the operator
            applies it.
          </p>
        </Surface>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.key}
          empty={loading ? "Loading…" : "No log entries in this range."}
        />
      )}
    </div>
  );
}

export default LogsClient;
