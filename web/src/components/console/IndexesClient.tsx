"use client";

import { useMemo, useState } from "react";

import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Badge } from "../ui/Badge";
import { useConfirm } from "../ui/AlertDialog";
import { Surface } from "../Surface";

/**
 * The Indexes screen (Studio Database → Indexes), MarketingHub-style. Browsing
 * (list + scan-counts + sizes) is free; creating an index (from a structured
 * definition, with a generated SQL preview) and dropping one are DDL and each
 * go behind the interrupting confirm modal — the guard sits on the WRITE, not
 * on the browse.
 *
 * All mutations flow through the group-gated /api/console/indexes route, which
 * re-validates every identifier against live introspection before any SQL runs.
 */

export interface IndexRow {
  schema: string;
  table: string;
  name: string;
  isUnique: boolean;
  isPrimary: boolean;
  definition: string;
  bytes: number;
  idxScan: number;
}

export interface IndexTableDto {
  schema: string;
  table: string;
  columns: string[];
}

const INDEX_METHODS = ["btree", "hash", "gin", "gist", "brin", "spgist"] as const;
type IndexMethod = (typeof INDEX_METHODS)[number];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

/** The generated statement — display only; the server rebuilds it safely. */
function previewDefinition(form: {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  method: IndexMethod;
}): string {
  const cols = form.columns.map((c) => `"${c}"`).join(", ") || "…";
  return (
    `create ${form.unique ? "unique " : ""}index "${form.name || "…"}" ` +
    `on "${form.schema}"."${form.table}" using ${form.method} (${cols})`
  );
}

export function IndexesClient({
  initialIndexes,
  tables,
}: {
  initialIndexes: IndexRow[];
  tables: IndexTableDto[];
}) {
  const [indexes, setIndexes] = useState<IndexRow[]>(initialIndexes);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { confirm, dialog } = useConfirm();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexes;
    return indexes.filter(
      (ix) =>
        ix.name.toLowerCase().includes(q) ||
        `${ix.schema}.${ix.table}`.toLowerCase().includes(q),
    );
  }, [indexes, query]);

  const totalBytes = useMemo(
    () => indexes.reduce((sum, ix) => sum + (ix.bytes || 0), 0),
    [indexes],
  );
  const unusedCount = useMemo(
    () => indexes.filter((ix) => !ix.isPrimary && ix.idxScan === 0).length,
    [indexes],
  );

  const refresh = async () => {
    try {
      const res = await fetch("/api/console/indexes");
      if (!res.ok) return;
      const body = (await res.json()) as { indexes: IndexRow[] };
      setIndexes(body.indexes);
    } catch {
      // best-effort; the last good list stays on screen
    }
  };

  const dropIndex = async (ix: IndexRow) => {
    if (ix.isPrimary) return; // PK indexes back a constraint — refused server-side
    const ok = await confirm({
      title: `Drop index ${ix.name}?`,
      message: (
        <>
          This permanently drops <code className="mono">{ix.name}</code> on{" "}
          <code className="mono">
            {ix.schema}.{ix.table}
          </code>
          . Queries relying on it may slow down or fall back to sequential
          scans. This cannot be undone.
        </>
      ),
      confirmLabel: "Drop index",
    });
    if (!ok) return;

    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/console/indexes", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: ix.schema, name: ix.name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Dropping the index failed.");
        return;
      }
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<IndexRow>[] = [
    {
      key: "table",
      header: "table",
      mono: true,
      width: "220px",
      render: (ix) => `${ix.schema}.${ix.table}`,
    },
    { key: "name", header: "index", mono: true },
    {
      key: "flags",
      header: "flags",
      width: "150px",
      render: (ix) => (
        <>
          {ix.isPrimary ? <Badge tone="var(--data-2)">primary</Badge> : null}
          {ix.isUnique && !ix.isPrimary ? <Badge tone="var(--data-3)">unique</Badge> : null}
          {!ix.isUnique && !ix.isPrimary ? <Badge>index</Badge> : null}
        </>
      ),
    },
    {
      key: "definition",
      header: "definition",
      mono: true,
      render: (ix) => (
        <span title={ix.definition}>
          {ix.definition.length > 72 ? `${ix.definition.slice(0, 71)}…` : ix.definition}
        </span>
      ),
    },
    {
      key: "bytes",
      header: "size",
      mono: true,
      align: "right",
      width: "90px",
      render: (ix) => formatBytes(ix.bytes),
    },
    {
      key: "idxScan",
      header: "scans",
      mono: true,
      align: "right",
      width: "90px",
      render: (ix) =>
        // Zero scans on a non-PK index is the attention state (dead weight).
        ix.isPrimary ? (
          ix.idxScan.toLocaleString()
        ) : (
          <span style={ix.idxScan === 0 ? { color: "var(--warn)" } : undefined}>
            {ix.idxScan.toLocaleString()}
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      width: "90px",
      align: "right",
      render: (ix) =>
        ix.isPrimary ? (
          <span className="teditor-test">PK</span>
        ) : (
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => dropIndex(ix)}
          >
            Drop
          </button>
        ),
    },
  ];

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Indexes" value={indexes.length} accent="var(--data-2)" />
        <StatCard label="Total size" value={formatBytes(totalBytes)} accent="var(--data-3)" />
        {/* No accent: unused (0-scan) secondary indexes are an attention state. */}
        <StatCard
          label="Unused"
          value={unusedCount}
          hint={unusedCount > 0 ? "0 scans (non-primary)" : "all in use"}
        />
      </div>

      <Section
        eyebrow="Database"
        title="Indexes"
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setCreateOpen((v) => !v);
              setError(null);
            }}
          >
            {createOpen ? "Close" : "Create index"}
          </button>
        }
      >
        {createOpen ? (
          <CreateIndexPanel
            tables={tables}
            busy={busy}
            confirm={confirm}
            onError={setError}
            onCreated={async () => {
              setCreateOpen(false);
              await refresh();
            }}
            setBusy={setBusy}
          />
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dgrid-toolbar" role="search">
          <input
            className="surface control"
            type="search"
            aria-label="Filter indexes"
            placeholder="Filter by index or table…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="spacer" />
          <button type="button" className="type-chip" onClick={refresh} disabled={busy}>
            Refresh
          </button>
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={(ix) => `${ix.schema}.${ix.table}.${ix.name}`}
          empty="No indexes in the managed schemas."
        />
      </Section>
      {dialog}
    </div>
  );
}

/**
 * Structured create form: pick a table, one or more of its columns, uniqueness
 * and access method. A live SQL preview is shown, and the same statement is put
 * in front of the confirm modal before the POST — "create from definition,"
 * without ever accepting raw SQL.
 */
function CreateIndexPanel({
  tables,
  busy,
  confirm,
  onError,
  onCreated,
  setBusy,
}: {
  tables: IndexTableDto[];
  busy: boolean;
  confirm: ReturnType<typeof useConfirm>["confirm"];
  onError: (msg: string | null) => void;
  onCreated: () => void | Promise<void>;
  setBusy: (v: boolean) => void;
}) {
  const [tableKey, setTableKey] = useState<string>(
    tables[0] ? `${tables[0].schema}.${tables[0].table}` : "",
  );
  const [name, setName] = useState("");
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState<IndexMethod>("btree");

  const selectedTable = useMemo(
    () => tables.find((t) => `${t.schema}.${t.table}` === tableKey) ?? null,
    [tables, tableKey],
  );

  const toggleColumn = (col: string) =>
    setSelectedCols((cols) =>
      cols.includes(col) ? cols.filter((c) => c !== col) : [...cols, col],
    );

  const canSubmit =
    selectedTable != null && name.trim().length > 0 && selectedCols.length > 0;

  const submit = async () => {
    if (!selectedTable || !canSubmit) return;
    const form = {
      schema: selectedTable.schema,
      table: selectedTable.table,
      name: name.trim(),
      columns: selectedCols,
      unique,
      method,
    };

    const ok = await confirm({
      title: "Create this index?",
      message: (
        <>
          This runs a DDL statement as <code className="mono">supabase_admin</code>.
          Building an index on a large table can lock writes for its duration.
          <pre className="mono" style={{ whiteSpace: "pre-wrap", marginTop: "0.6rem" }}>
            {previewDefinition(form)}
          </pre>
        </>
      ),
      confirmLabel: "Create index",
    });
    if (!ok) return;

    onError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/console/indexes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        onError(body?.error ?? "Creating the index failed.");
        return;
      }
      await onCreated();
    } catch {
      onError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (tables.length === 0) {
    return (
      <Surface className="teditor-insert" elevated={false}>
        <p className="teditor-test">No tables available in the managed schemas.</p>
      </Surface>
    );
  }

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">New index</span>
      <div className="dgrid-toolbar">
        <select
          className="surface control"
          aria-label="Table"
          value={tableKey}
          onChange={(e) => {
            setTableKey(e.target.value);
            setSelectedCols([]);
          }}
        >
          {tables.map((t) => {
            const key = `${t.schema}.${t.table}`;
            return (
              <option key={key} value={key}>
                {key}
              </option>
            );
          })}
        </select>
        <input
          className="surface control mono"
          type="text"
          aria-label="Index name"
          placeholder="index_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="surface control"
          aria-label="Index method"
          value={method}
          onChange={(e) => setMethod(e.target.value as IndexMethod)}
        >
          {INDEX_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <label className="teditor-null">
          <input
            type="checkbox"
            checked={unique}
            onChange={(e) => setUnique(e.target.checked)}
          />{" "}
          unique
        </label>
      </div>

      <div className="dgrid-toolbar" role="group" aria-label="Columns">
        {(selectedTable?.columns ?? []).map((col) => (
          <button
            key={col}
            type="button"
            className={selectedCols.includes(col) ? "type-chip on" : "type-chip"}
            onClick={() => toggleColumn(col)}
          >
            {col}
          </button>
        ))}
      </div>

      <pre
        className="mono"
        style={{ whiteSpace: "pre-wrap", opacity: 0.8, margin: "0.4rem 0" }}
      >
        {previewDefinition({
          schema: selectedTable?.schema ?? "",
          table: selectedTable?.table ?? "",
          name: name.trim(),
          columns: selectedCols,
          unique,
          method,
        })}
      </pre>

      <div className="form-actions">
        <button type="button" className="btn-primary" onClick={submit} disabled={busy || !canSubmit}>
          Create index
        </button>
      </div>
    </Surface>
  );
}

export default IndexesClient;
