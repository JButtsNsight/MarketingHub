"use client";

import { useState } from "react";
import { SqlEditor } from "../ui/SqlEditor";
import { DataTable, type Column } from "../ui/DataTable";
import { Badge } from "../ui/Badge";
import { Surface } from "../Surface";
import { Guide } from "@/components/guide/Guide";
import { AssistantPanel } from "./AssistantPanel";

/**
 * The SQL editor screen (Studio parity): CodeMirror editor with ⌘/Ctrl+Enter
 * run, a results grid, CSV export, saved snippets, and query history — all
 * through the group-gated /api/console/sql* routes.
 *
 * Write handshake: the server 409s any statement it cannot prove read-only;
 * the Run button then becomes an explicit "Run write" confirm. One second
 * click, no ceremony — and every run lands in the history audit trail.
 */

export interface SnippetDto {
  id: string;
  name: string;
  sql: string;
  created_by: string;
  updated_at: string;
}

export interface HistoryDto {
  id: string;
  sql: string;
  ran_by: string;
  ran_at: string;
  duration_ms: number | null;
  row_count: number | null;
  error: string | null;
}

interface RunResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Deterministic UTC stamp (hydration-safe, same as InboxTable). */
function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function SqlConsole({
  initialSnippets,
  initialHistory,
}: {
  initialSnippets: SnippetDto[];
  initialHistory: HistoryDto[];
}) {
  const [doc, setDoc] = useState(
    "select schemaname, relname, n_live_tup\nfrom pg_stat_user_tables\norder by n_live_tup desc\nlimit 20;",
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [snippets, setSnippets] = useState(initialSnippets);
  const [history, setHistory] = useState(initialHistory);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [armedSnippet, setArmedSnippet] = useState<string | null>(null);

  /** ANY document change disarms a pending write confirm. The confirmation
   * was granted for the PREVIOUS statement, and /api/console/sql runs
   * `confirmWrite: true` writes immediately — a swapped-in statement
   * (assistant proposal, snippet, history, typing) must face its own
   * classify → 409 → confirm handshake. */
  const updateDoc = (next: string) => {
    setDoc(next);
    setNeedsConfirm(false);
  };

  const refreshHistory = async () => {
    try {
      const res = await fetch("/api/console/sql");
      if (!res.ok) return;
      const body = (await res.json()) as { history: HistoryDto[] };
      setHistory(body.history);
    } catch {
      // history refresh is best-effort
    }
  };

  const run = async (confirmWrite: boolean) => {
    if (!doc.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/console/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql: doc, ...(confirmWrite ? { confirmWrite } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | (RunResult & { requiresConfirmation?: boolean; error?: string })
        | null;
      if (res.status === 409 && body?.requiresConfirmation) {
        setNeedsConfirm(true);
        return;
      }
      setNeedsConfirm(false);
      if (!res.ok) {
        setError(body?.error ?? "Query failed.");
        setResult(null);
        void refreshHistory();
        return;
      }
      setResult(body as RunResult);
      void refreshHistory();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setRunning(false);
    }
  };

  const saveSnippet = async () => {
    if (!saveName.trim() || !doc.trim()) return;
    try {
      const res = await fetch("/api/console/snippets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: saveName.trim(), sql: doc }),
      });
      if (!res.ok) {
        setError("Saving the snippet failed.");
        return;
      }
      const body = (await res.json()) as { snippet: SnippetDto };
      setSnippets([body.snippet, ...snippets]);
      setSaveOpen(false);
      setSaveName("");
    } catch {
      setError("Network error — please try again.");
    }
  };

  const deleteSnippet = async (id: string) => {
    try {
      const res = await fetch(`/api/console/snippets/${id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setSnippets(snippets.filter((s) => s.id !== id));
      }
    } catch {
      // leave the snippet in place; nothing was removed
    } finally {
      setArmedSnippet(null);
    }
  };

  const exportCsv = () => {
    if (!result || result.rows.length === 0) return;
    const cols = Object.keys(result.rows[0]);
    const lines = [
      cols.join(","),
      ...result.rows.map((r) => cols.map((c) => csvEscape(cellText(r[c]))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "query-results.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const resultColumns: Column<Record<string, unknown>>[] =
    result && result.rows.length > 0
      ? Object.keys(result.rows[0]).map((name) => ({
          key: name,
          header: name,
          mono: true,
          render: (r) => {
            const text = cellText(r[name]);
            return (
              <span title={text}>
                {text.length > 100 ? `${text.slice(0, 99)}…` : text}
              </span>
            );
          },
        }))
      : [];

  return (
    <div className="sqlconsole">
      <div className="sqlconsole-main">
        <Guide id="sql.editor.input">
          <SqlEditor value={doc} onChange={updateDoc} onRun={() => void run(false)} />
        </Guide>

        <div className="dgrid-toolbar">
          {needsConfirm ? (
            <>
              <Guide id="sql.editor.write-warning">
                <span className="form-error" role="alert">
                  This statement modifies the database — confirm to run it.
                </span>
              </Guide>
              <Guide id="sql.editor.run-write">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={running}
                  onClick={() => void run(true)}
                >
                  Run write
                </button>
              </Guide>
              <Guide id="sql.editor.cancel-write">
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => setNeedsConfirm(false)}
                >
                  Cancel
                </button>
              </Guide>
            </>
          ) : (
            <Guide id="sql.editor.run">
              <button
                type="button"
                className="btn-primary"
                disabled={running || !doc.trim()}
                onClick={() => void run(false)}
              >
                {running ? "Running…" : "Run (⌘⏎)"}
              </button>
            </Guide>
          )}
          <span className="spacer" />
          {result ? (
            <>
              <Guide id="sql.editor.result-meta">
                <span className="teditor-test mono">
                  {result.rowCount.toLocaleString()} row
                  {result.rowCount === 1 ? "" : "s"}
                  {result.truncated ? " (showing first 1,000)" : ""} ·{" "}
                  {result.durationMs} ms
                </span>
              </Guide>
              <Guide id="sql.editor.export-csv">
                <button type="button" className="type-chip" onClick={exportCsv}>
                  Export CSV
                </button>
              </Guide>
            </>
          ) : null}
          {saveOpen ? (
            <>
              <Guide id="sql.editor.snippet-name">
                <input
                  className="surface control teditor-fctl"
                  type="text"
                  aria-label="Snippet name"
                  placeholder="snippet name"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                />
              </Guide>
              <Guide id="sql.editor.snippet-save">
                <button type="button" className="type-chip" onClick={() => void saveSnippet()}>
                  Save
                </button>
              </Guide>
              <Guide id="sql.editor.snippet-cancel">
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => setSaveOpen(false)}
                >
                  Cancel
                </button>
              </Guide>
            </>
          ) : (
            <Guide id="sql.editor.save-snippet">
              <button
                type="button"
                className="type-chip"
                onClick={() => setSaveOpen(true)}
              >
                Save snippet
              </button>
            </Guide>
          )}
        </div>

        {error ? (
          <Guide id="sql.editor.error">
            <p className="form-error mono" role="alert">
              {error}
            </p>
          </Guide>
        ) : null}

        {result ? (
          result.rows.length > 0 ? (
            <Guide id="sql.editor.results">
              <DataTable
                columns={resultColumns}
                rows={result.rows}
                getRowKey={(_, i) => String(i)}
                empty="No rows."
              />
            </Guide>
          ) : (
            <Guide id="sql.editor.no-rows">
              <Surface className="empty-state" glint>
                <h2>Success — no rows</h2>
                <p>The statement ran without returning rows.</p>
              </Surface>
            </Guide>
          )
        ) : null}
      </div>

      <Surface as="aside" className="sqlconsole-rail" glint>
        {/* Proposals REPLACE the editor document and disarm any pending
            write confirm — running stays the classify → confirm-write flow
            above. */}
        <AssistantPanel onInsert={updateDoc} />

        <div className="nav-group">
          <span className="nav-group-label">Snippets</span>
          <Guide id="sql.snippets.list">
            <ul className="nav-list">
              {snippets.length === 0 ? (
                <li className="teditor-test">Nothing saved yet.</li>
              ) : (
                snippets.map((s) => (
                  <li key={s.id} className="sqlconsole-snippet">
                    <Guide id="sql.snippets.load">
                      <button
                        type="button"
                        className="nav-link"
                        title={s.sql}
                        onClick={() => updateDoc(s.sql)}
                      >
                        <span className="teditor-tname">{s.name}</span>
                      </button>
                    </Guide>
                    {armedSnippet === s.id ? (
                      <Guide id="sql.snippets.delete-confirm">
                        <button
                          type="button"
                          className="type-chip"
                          onClick={() => void deleteSnippet(s.id)}
                        >
                          Confirm ✕
                        </button>
                      </Guide>
                    ) : (
                      <Guide id="sql.snippets.delete">
                        <button
                          type="button"
                          className="type-chip"
                          aria-label={`Delete snippet ${s.name}`}
                          onClick={() => setArmedSnippet(s.id)}
                        >
                          ✕
                        </button>
                      </Guide>
                    )}
                  </li>
                ))
              )}
            </ul>
          </Guide>
        </div>

        <div className="nav-group">
          <span className="nav-group-label">History</span>
          <Guide id="sql.history.list">
            <ul className="nav-list">
              {history.length === 0 ? (
                <li className="teditor-test">No runs yet.</li>
              ) : (
                history.slice(0, 25).map((entry) => (
                  <li key={entry.id}>
                    <Guide id="sql.history.entry">
                      <button
                        type="button"
                        className="nav-link sqlconsole-hentry"
                        title={entry.sql}
                        onClick={() => updateDoc(entry.sql)}
                      >
                        <span className="teditor-tname mono">
                          {entry.sql.length > 36
                            ? `${entry.sql.slice(0, 35)}…`
                            : entry.sql}
                        </span>
                        <span className="teditor-test">
                          {stamp(entry.ran_at)} ·{" "}
                          {entry.error ? (
                            <Badge tone="var(--fail)">error</Badge>
                          ) : (
                            `${entry.row_count ?? 0} rows`
                          )}
                        </span>
                      </button>
                    </Guide>
                  </li>
                ))
              )}
            </ul>
          </Guide>
        </div>
      </Surface>
    </div>
  );
}

export default SqlConsole;
