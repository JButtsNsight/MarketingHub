"use client";

import { useState } from "react";

import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { useConfirm } from "../ui/AlertDialog";
import { Surface } from "../Surface";

/**
 * Database → Functions (Studio parity). A read table of every routine across
 * the marketinghub / public / pgmq_public schemas — name, args, return type,
 * language, and the SECURITY DEFINER flag (a security-relevant attribute, so it
 * gets an attention tone). Each row can reveal its full definition (a read) and
 * be dropped.
 *
 * The guard sits on the WRITE: dropping a function is DDL and irreversible, so
 * it goes behind the interrupting confirm modal (useConfirm). Browsing and
 * viewing a definition need no confirmation.
 */

export interface PgFunctionDto {
  oid: number;
  schema: string;
  name: string;
  /** Arg types only (`integer, text`) — the DROP-disambiguating signature. */
  identityArguments: string;
  /** Full arg list incl. names/defaults, for display. */
  arguments: string;
  returnType: string;
  language: string;
  kind: string;
  securityDefiner: boolean;
}

function signature(fn: PgFunctionDto): string {
  return `${fn.schema}.${fn.name}(${fn.identityArguments})`;
}

export function FunctionsClient({
  initialFunctions,
}: {
  initialFunctions: PgFunctionDto[];
}) {
  const [functions, setFunctions] = useState(initialFunctions);
  const [error, setError] = useState<string | null>(null);

  // The routine whose definition is being shown, plus its loaded source.
  const [openOid, setOpenOid] = useState<number | null>(null);
  const [defn, setDefn] = useState<string | null>(null);
  const [defnLoading, setDefnLoading] = useState(false);
  const [defnNote, setDefnNote] = useState<string | null>(null);

  const [dropping, setDropping] = useState<number | null>(null);

  const { confirm, dialog } = useConfirm();

  const showDefinition = async (fn: PgFunctionDto) => {
    // Toggle closed if the same row's definition is already open.
    if (openOid === fn.oid) {
      setOpenOid(null);
      return;
    }
    setOpenOid(fn.oid);
    setDefn(null);
    setDefnNote(null);
    setDefnLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/console/functions?oid=${fn.oid}`);
      const body = (await res.json().catch(() => null)) as
        | { definition?: string | null; kind?: string; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Loading the definition failed.");
        setOpenOid(null);
        return;
      }
      if (body?.definition == null) {
        setDefn(null);
        setDefnNote(
          `Source is not available for ${body?.kind ?? "this"} routines.`,
        );
      } else {
        setDefn(body.definition);
      }
    } catch {
      setError("Network error — please try again.");
      setOpenOid(null);
    } finally {
      setDefnLoading(false);
    }
  };

  const requestDrop = async (fn: PgFunctionDto) => {
    const ok = await confirm({
      title: "Drop this function?",
      message: (
        <>
          <code className="mono">{signature(fn)}</code> will be permanently
          dropped. This is DDL and cannot be undone. Anything that depends on it
          (triggers, views, other routines) may break.
        </>
      ),
      confirmLabel: "Drop function",
    });
    if (!ok) return;

    setDropping(fn.oid);
    setError(null);
    try {
      const res = await fetch("/api/console/functions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oid: fn.oid }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Dropping the function failed.");
        return;
      }
      setFunctions((prev) => prev.filter((f) => f.oid !== fn.oid));
      if (openOid === fn.oid) setOpenOid(null);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setDropping(null);
    }
  };

  const columns: Column<PgFunctionDto>[] = [
    {
      key: "name",
      header: "function",
      mono: true,
      render: (f) => `${f.schema}.${f.name}`,
    },
    {
      key: "arguments",
      header: "arguments",
      mono: true,
      render: (f) => {
        const text = f.arguments || "—";
        return (
          <span title={text}>{text.length > 60 ? `${text.slice(0, 59)}…` : text}</span>
        );
      },
    },
    {
      key: "returnType",
      header: "returns",
      mono: true,
      width: "160px",
      render: (f) => {
        const text = f.returnType || "—";
        return (
          <span title={text}>{text.length > 30 ? `${text.slice(0, 29)}…` : text}</span>
        );
      },
    },
    {
      key: "kind",
      header: "kind",
      width: "110px",
      render: (f) => <Badge>{f.kind}</Badge>,
    },
    {
      key: "language",
      header: "lang",
      width: "90px",
      render: (f) => <Badge tone="var(--data-2)">{f.language}</Badge>,
    },
    {
      key: "securityDefiner",
      header: "security",
      width: "120px",
      // SECURITY DEFINER runs with the owner's rights — the attention state.
      render: (f) =>
        f.securityDefiner ? (
          <Badge tone="var(--warn)">definer</Badge>
        ) : (
          <Badge>invoker</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      width: "200px",
      align: "right",
      render: (f) => (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className={openOid === f.oid ? "type-chip on" : "type-chip"}
            onClick={() => showDefinition(f)}
          >
            {openOid === f.oid ? "Hide" : "Definition"}
          </button>
          <button
            type="button"
            className="type-chip"
            disabled={dropping === f.oid}
            onClick={() => requestDrop(f)}
          >
            {dropping === f.oid ? "Dropping…" : "Drop"}
          </button>
        </div>
      ),
    },
  ];

  const openFn = functions.find((f) => f.oid === openOid) ?? null;
  const definerCount = functions.filter((f) => f.securityDefiner).length;
  const schemaCount = new Set(functions.map((f) => f.schema)).size;

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Functions" value={functions.length} accent="var(--data-3)" />
        {/* No accent: SECURITY DEFINER is a posture to keep an eye on. */}
        <StatCard
          label="Security definer"
          value={definerCount}
          hint={definerCount > 0 ? "run as owner" : "all invoker"}
        />
        <StatCard label="Schemas" value={schemaCount} accent="var(--data-2)" />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <Section
        eyebrow="Routines"
        title="Functions"
        description="Live routines from pg_proc across marketinghub, public, and pgmq_public."
      >
        <DataTable
          columns={columns}
          rows={functions}
          getRowKey={(f) => String(f.oid)}
          empty="No functions in these schemas."
        />
      </Section>

      {openFn ? (
        <Surface className="teditor-insert" elevated={false}>
          <div
            className="dgrid-toolbar"
            style={{ border: "none", padding: 0 }}
          >
            <span className="eyebrow">Definition · {signature(openFn)}</span>
            <span className="spacer" />
            <button
              type="button"
              className="type-chip"
              onClick={() => setOpenOid(null)}
            >
              Close
            </button>
          </div>
          {defnLoading ? (
            <p className="teditor-test">Loading definition…</p>
          ) : defnNote ? (
            <p className="teditor-test">{defnNote}</p>
          ) : defn ? (
            <CodeBlock code={defn} label={openFn.language} />
          ) : null}
        </Surface>
      ) : null}

      {dialog}
    </div>
  );
}

export default FunctionsClient;
