"use client";

import { useState } from "react";

import { Surface } from "@/components/Surface";
import { useConfirm } from "@/components/ui/AlertDialog";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Section } from "@/components/ui/Section";

/**
 * The interactive half of the impersonation console. The first mint in a
 * session is interrupted by the confirm modal (a real credential gets minted);
 * after that, runs go straight through — the server still enforces its own
 * `confirm: true` handshake on every request. Results render side by side:
 * what the impersonated `authenticated` identity can see vs what
 * `service_role` sees for the same select. Only the token's CLAIMS come back;
 * the raw JWT never leaves the server.
 */

const TABLE_RE = /^[a-z_][a-z0-9_]*$/;

interface SideResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  error?: string;
}

interface ImpersonationResponse {
  claims: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
  error?: string;
  serviceRole: SideResult;
}

function cellText(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function columnsFor(
  rows: Array<Record<string, unknown>>,
): Column<Record<string, unknown>>[] {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  return keys.map((key) => ({
    key,
    header: key,
    mono: true,
    render: (row) => {
      const text = cellText(row[key]);
      return (
        <span title={text}>
          {text.length > 80 ? `${text.slice(0, 79)}…` : text}
        </span>
      );
    },
  }));
}

function ResultPanel({
  eyebrow,
  title,
  side,
  emptyLabel,
}: {
  eyebrow: string;
  title: string;
  side: SideResult;
  emptyLabel: string;
}) {
  return (
    <Section
      eyebrow={eyebrow}
      title={title}
      actions={
        <span className="count mono">
          {side.rowCount == null ? "error" : `${side.rowCount} rows`}
        </span>
      }
    >
      {side.error ? (
        <p className="form-error" role="alert">
          {side.error}
        </p>
      ) : (
        <DataTable
          columns={columnsFor(side.rows)}
          rows={side.rows}
          getRowKey={(row, i) =>
            typeof row.id === "string" ? row.id : String(i)
          }
          empty={emptyLabel}
        />
      )}
    </Section>
  );
}

export function ImpersonateClient() {
  const [email, setEmail] = useState("");
  const [groupsText, setGroupsText] = useState("marketing");
  const [ttlSeconds, setTtlSeconds] = useState(300);
  const [table, setTable] = useState("templates");
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImpersonationResponse | null>(null);
  // The modal interrupts the FIRST mint of the session only.
  const [sessionConfirmed, setSessionConfirmed] = useState(false);

  const { confirm, dialog } = useConfirm();

  const submit = async () => {
    setError(null);
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (!TABLE_RE.test(table.trim())) {
      setError("Table must be a lowercase snake_case identifier.");
      return;
    }

    if (!sessionConfirmed) {
      const ok = await confirm({
        title: "Mint an impersonation token?",
        message:
          "This mints a real, short-lived credential (role authenticated, " +
          "15-minute ceiling) and runs the query as that identity. Every " +
          "mint and query is audited under your email.",
        confirmLabel: "Mint & run",
      });
      if (!ok) return;
      setSessionConfirmed(true);
    }

    setBusy(true);
    try {
      const res = await fetch("/api/console/impersonate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          groups: groupsText
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean),
          ttlSeconds,
          schema: "marketinghub",
          table: table.trim(),
          limit,
          confirm: true,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | (ImpersonationResponse & { error?: string })
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Request failed.");
        setResult(null);
        return;
      }
      if (body) setResult(body);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Surface className="teditor-insert" elevated={false}>
        <span className="eyebrow">Identity to impersonate</span>

        <div className="field">
          <label htmlFor="imp-email">email</label>
          <input
            id="imp-email"
            className="surface control mono"
            type="text"
            placeholder="someone@nsightcare.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="imp-groups">groups (comma-separated)</label>
          <input
            id="imp-groups"
            className="surface control mono"
            type="text"
            placeholder="marketing"
            value={groupsText}
            onChange={(e) => setGroupsText(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="imp-ttl">token ttl (seconds, 60–900)</label>
          <input
            id="imp-ttl"
            className="surface control mono"
            type="number"
            min={60}
            max={900}
            value={ttlSeconds}
            onChange={(e) => setTtlSeconds(Number(e.target.value))}
          />
        </div>

        <div className="field">
          <label htmlFor="imp-table">table (schema marketinghub)</label>
          <input
            id="imp-table"
            className="surface control mono"
            type="text"
            placeholder="templates"
            value={table}
            onChange={(e) => setTable(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="imp-limit">row limit (1–100)</label>
          <input
            id="imp-limit"
            className="surface control mono"
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="form-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Running…" : "Mint token & run query"}
          </button>
        </div>
      </Surface>

      {result ? (
        <>
          <Section eyebrow="Token" title="Minted claims">
            <CodeBlock
              label="jwt claims — the raw token never leaves the server"
              code={JSON.stringify(result.claims, null, 2)}
            />
          </Section>

          <div className="split-2">
            <ResultPanel
              eyebrow="authenticated"
              title="As impersonated user"
              side={{
                rows: result.rows,
                rowCount: result.rowCount,
                error: result.error,
              }}
              emptyLabel="No rows visible to this identity."
            />
            <ResultPanel
              eyebrow="service_role"
              title="As service_role"
              side={result.serviceRole}
              emptyLabel="No rows in this table."
            />
          </div>
        </>
      ) : null}

      {dialog}
    </div>
  );
}

export default ImpersonateClient;
