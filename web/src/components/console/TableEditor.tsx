"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataGrid,
  type GridCellValue,
  type GridColumn,
  type GridSort,
} from "../ui/DataGrid";
import { Surface } from "../Surface";

/**
 * The Table Editor — Studio's flagship screen, MarketingHub-style. A schema-
 * grouped table rail on the left; on the right a toolbar (filters, insert,
 * delete, CSV, refresh) over an editable DataGrid with server-side
 * pagination. All data flows through the group-gated /api/console/rows
 * routes; structure comes from live pg-meta introspection passed down by the
 * server page (and refreshable via /api/console/tables).
 *
 * Sensitive tables (SMS outbox/audit, storage metadata) stay editable — owner
 * decision: full parity, guarded — but carry a warning banner: hand edits can
 * break at-most-once send accounting or TCPA evidence.
 */

export interface EditorColumnDto {
  name: string;
  dataType: string;
  format: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isEditable: boolean;
  defaultValue: string | null;
  enums: string[];
  comment: string | null;
}

export interface EditorTableDto {
  schema: string;
  name: string;
  rowsEstimate: number;
  size: string;
  rlsEnabled: boolean;
  comment: string | null;
  primaryKeys: string[];
  sensitive: boolean;
  columns: EditorColumnDto[];
}

interface Filter {
  column: string;
  op: string;
  value: string;
}

const FILTER_OPS = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "ilike", label: "ilike" },
  { value: "is", label: "is null / not null" },
];

const PAGE_SIZES = [25, 50, 100, 500];

function csvEscape(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function TableEditor({ initialTables }: { initialTables: EditorTableDto[] }) {
  const [tables, setTables] = useState(initialTables);
  const [selected, setSelected] = useState<EditorTableDto | null>(
    initialTables.find((t) => t.schema === "marketinghub") ?? initialTables[0] ?? null,
  );
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Draft filter row in the toolbar.
  const [draft, setDraft] = useState<Filter>({ column: "", op: "eq", value: "" });

  const gridColumns: GridColumn[] = useMemo(
    () =>
      (selected?.columns ?? []).map((c) => ({
        name: c.name,
        format: c.format,
        isPrimaryKey: c.isPrimaryKey,
        isNullable: c.isNullable,
        // Cells are editable only when the row is addressable by a full PK.
        isEditable:
          c.isEditable && !c.isPrimaryKey && (selected?.primaryKeys.length ?? 0) > 0,
        enums: c.enums,
      })),
    [selected],
  );

  const pkOf = useCallback(
    (row: Record<string, unknown>) =>
      Object.fromEntries((selected?.primaryKeys ?? []).map((k) => [k, row[k]])),
    [selected],
  );

  // JSON-encode the PK so composite-key segments can't concatenate into a
  // colliding key (a value containing a chosen separator would otherwise let
  // one row's selection/delete hit another).
  const rowKey = useCallback(
    (row: Record<string, unknown>) =>
      selected && selected.primaryKeys.length > 0
        ? JSON.stringify(pkOf(row))
        : JSON.stringify(row),
    [selected, pkOf],
  );

  // Latest-wins row fetch — a stale response must never clobber a newer one.
  const fetchSeq = useRef(0);
  useEffect(() => {
    if (!selected) return;
    const seq = ++fetchSeq.current;
    const params = new URLSearchParams({
      schema: selected.schema,
      table: selected.name,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (sort) {
      params.set("sort", sort.column);
      params.set("dir", sort.ascending ? "asc" : "desc");
    }
    if (filters.length > 0) params.set("filters", JSON.stringify(filters));

    setLoading(true);
    setError(null);
    fetch(`/api/console/rows?${params}`)
      .then(async (res) => {
        if (seq !== fetchSeq.current) return;
        const body = (await res.json().catch(() => null)) as
          | { rows?: Array<Record<string, unknown>>; total?: number; error?: string }
          | null;
        if (!res.ok) {
          setError(body?.error ?? "Loading rows failed.");
          setRows([]);
          setTotal(0);
          return;
        }
        setRows(body?.rows ?? []);
        setTotal(body?.total ?? 0);
      })
      .catch(() => {
        if (seq === fetchSeq.current) setError("Network error — please try again.");
      })
      .finally(() => {
        if (seq === fetchSeq.current) setLoading(false);
      });
  }, [selected, page, pageSize, sort, filters, refreshTick]);

  const refresh = () => setRefreshTick((t) => t + 1);

  const selectTable = (t: EditorTableDto) => {
    setSelected(t);
    setPage(0);
    setSort(null);
    setFilters([]);
    setSelectedKeys(new Set());
    setConfirmDelete(false);
    setInsertOpen(false);
  };

  const refreshTables = async () => {
    try {
      const res = await fetch("/api/console/tables");
      if (!res.ok) return;
      const body = (await res.json()) as { tables: EditorTableDto[] };
      setTables(body.tables);
      if (selected) {
        const fresh = body.tables.find(
          (t) => t.schema === selected.schema && t.name === selected.name,
        );
        if (fresh) setSelected(fresh);
      }
    } catch {
      // rail refresh is best-effort; the grid has its own error surface
    }
  };

  const onCellEdit = async (
    row: Record<string, unknown>,
    column: GridColumn,
    value: GridCellValue,
  ): Promise<boolean> => {
    if (!selected) return false;
    setError(null);
    try {
      const res = await fetch("/api/console/rows", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: selected.schema,
          table: selected.name,
          pk: pkOf(row),
          patch: { [column.name]: value },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Saving the cell failed.");
        return false;
      }
      refresh();
      return true;
    } catch {
      setError("Network error — please try again.");
      return false;
    }
  };

  const deleteSelected = async () => {
    if (!selected || selectedKeys.size === 0) return;
    const keys = rows.filter((r) => selectedKeys.has(rowKey(r))).map(pkOf);
    setError(null);
    try {
      const res = await fetch("/api/console/rows", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: selected.schema, table: selected.name, keys }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Deleting rows failed.");
        return;
      }
      setSelectedKeys(new Set());
      refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setConfirmDelete(false);
    }
  };

  const exportCsv = () => {
    if (!selected || rows.length === 0) return;
    const cols = selected.columns.map((c) => c.name);
    const lines = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${selected.schema}.${selected.name}.page-${page + 1}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const schemas = [...new Set(tables.map((t) => t.schema))];

  return (
    <div className="teditor">
      <Surface as="aside" className="teditor-rail" glint>
        {schemas.map((schema) => (
          <div className="nav-group" key={schema}>
            <span className="nav-group-label">{schema}</span>
            <ul className="nav-list">
              {tables
                .filter((t) => t.schema === schema)
                .map((t) => {
                  const active =
                    selected?.schema === t.schema && selected?.name === t.name;
                  return (
                    <li key={`${t.schema}.${t.name}`}>
                      <button
                        type="button"
                        className={active ? "nav-link on" : "nav-link"}
                        onClick={() => selectTable(t)}
                      >
                        <span className="teditor-tname">{t.name}</span>
                        <span className="teditor-test">
                          {t.rowsEstimate.toLocaleString()}
                        </span>
                      </button>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </Surface>

      <div className="teditor-main">
        {selected ? (
          <>
            {selected.sensitive ? (
              <p className="form-error teditor-warn" role="alert">
                {selected.schema === "storage"
                  ? "Storage metadata table — rows here must stay consistent with the underlying S3 objects. Prefer the Storage browser."
                  : "SMS outbox/audit table — hand edits can break at-most-once send accounting or TCPA evidence. Prefer the product UI (Campaigns / Suppressions / Review queue)."}
              </p>
            ) : null}

            <div className="dgrid-toolbar">
              <span className="eyebrow">
                {selected.schema}.{selected.name}
              </span>
              <span className="teditor-test mono">
                {total.toLocaleString()} row{total === 1 ? "" : "s"}
                {selected.primaryKeys.length === 0 ? " · no PK — browse only" : ""}
              </span>
              <span className="spacer" />
              <button type="button" className="type-chip" onClick={exportCsv}>
                Export page CSV
              </button>
              <button type="button" className="type-chip" onClick={() => { refresh(); void refreshTables(); }}>
                Refresh
              </button>
              {selectedKeys.size > 0 ? (
                confirmDelete ? (
                  <>
                    <button type="button" className="type-chip" onClick={deleteSelected}>
                      Confirm delete {selectedKeys.size}
                    </button>
                    <button
                      type="button"
                      className="type-chip"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="type-chip"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete {selectedKeys.size} selected
                  </button>
                )
              ) : null}
              {selected.primaryKeys.length > 0 ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setInsertOpen((v) => !v)}
                >
                  {insertOpen ? "Close insert" : "Insert row"}
                </button>
              ) : null}
            </div>

            <div className="dgrid-toolbar" role="search">
              <select
                className="surface control teditor-fctl"
                aria-label="Filter column"
                value={draft.column}
                onChange={(e) => setDraft({ ...draft, column: e.target.value })}
              >
                <option value="">filter column…</option>
                {selected.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="surface control teditor-fctl"
                aria-label="Filter operator"
                value={draft.op}
                onChange={(e) => setDraft({ ...draft, op: e.target.value })}
              >
                {FILTER_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {draft.op === "is" ? (
                <select
                  className="surface control teditor-fctl"
                  aria-label="Filter value"
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                >
                  <option value="null">null</option>
                  <option value="not.null">not null</option>
                </select>
              ) : (
                <input
                  className="surface control teditor-fctl"
                  aria-label="Filter value"
                  type="text"
                  placeholder="value"
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                />
              )}
              <button
                type="button"
                className="type-chip"
                onClick={() => {
                  if (!draft.column) return;
                  const value = draft.op === "is" && !draft.value ? "null" : draft.value;
                  setFilters([...filters, { ...draft, value }]);
                  setDraft({ column: "", op: "eq", value: "" });
                  setPage(0);
                }}
              >
                Add filter
              </button>
              {filters.map((f, i) => (
                <button
                  key={`${f.column}-${i}`}
                  type="button"
                  className="type-chip on"
                  title="Remove filter"
                  onClick={() => {
                    setFilters(filters.filter((_, j) => j !== i));
                    setPage(0);
                  }}
                >
                  {f.column} {FILTER_OPS.find((o) => o.value === f.op)?.label ?? f.op}{" "}
                  {f.op === "is" ? f.value.replace(".", " ") : f.value} ✕
                </button>
              ))}
            </div>

            {insertOpen ? (
              <InsertRowPanel
                table={selected}
                onDone={(ok) => {
                  setInsertOpen(false);
                  if (ok) refresh();
                }}
              />
            ) : null}

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className={loading ? "dgrid-busy" : undefined}>
              <DataGrid
                columns={gridColumns}
                rows={rows}
                getRowKey={rowKey}
                sort={sort}
                onSortChange={(s) => {
                  setSort(s);
                  setPage(0);
                }}
                selectedKeys={selectedKeys}
                onSelectionChange={(keys) => {
                  setSelectedKeys(keys);
                  setConfirmDelete(false);
                }}
                onCellEdit={selected.primaryKeys.length > 0 ? onCellEdit : undefined}
                empty="No rows match."
              />
            </div>

            <div className="dgrid-pager">
              <select
                className="surface control teditor-fctl"
                aria-label="Rows per page"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="type-chip"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Prev
              </button>
              <span>
                page {page + 1} of {pageCount}
              </span>
              <button
                type="button"
                className="type-chip"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          </>
        ) : (
          <Surface className="empty-state" glint>
            <h2>No tables</h2>
            <p>The exposed schemas contain no tables to browse.</p>
          </Surface>
        )}
      </div>
    </div>
  );
}

/**
 * Insert form: one field per writable column. Blank = omitted (Postgres
 * applies the default); the NULL checkbox sends an explicit null.
 */
function InsertRowPanel({
  table,
  onDone,
}: {
  table: EditorTableDto;
  onDone: (inserted: boolean) => void;
}) {
  const writable = table.columns.filter((c) => c.isEditable);
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const payload: Record<string, unknown> = {};
    for (const c of writable) {
      if (nulls[c.name]) payload[c.name] = null;
      else if ((values[c.name] ?? "") !== "") payload[c.name] = values[c.name];
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/console/rows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: table.schema, table: table.name, values: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Insert failed.");
        setBusy(false);
        return;
      }
      onDone(true);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">Insert into {table.schema}.{table.name}</span>
      <div className="teditor-insert-grid">
        {writable.map((c) => (
          <div className="field" key={c.name}>
            <label htmlFor={`ins-${c.name}`}>
              {c.name}
              <span className="teditor-test mono"> {c.format}</span>
            </label>
            {c.enums.length > 0 ? (
              <select
                id={`ins-${c.name}`}
                className="surface control"
                value={values[c.name] ?? ""}
                disabled={nulls[c.name] === true}
                onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
              >
                <option value="">(default)</option>
                {c.enums.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`ins-${c.name}`}
                className="surface control mono"
                type="text"
                placeholder={c.defaultValue ?? (c.isNullable ? "null" : "required")}
                value={values[c.name] ?? ""}
                disabled={nulls[c.name] === true}
                onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
              />
            )}
            {c.isNullable ? (
              <label className="teditor-null">
                <input
                  type="checkbox"
                  checked={nulls[c.name] === true}
                  onChange={(e) => setNulls({ ...nulls, [c.name]: e.target.checked })}
                />{" "}
                NULL
              </label>
            ) : null}
          </div>
        ))}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="type-chip" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          Insert row
        </button>
      </div>
    </Surface>
  );
}

export default TableEditor;
