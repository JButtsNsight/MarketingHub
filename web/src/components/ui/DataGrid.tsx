"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Studio-style editable data grid — the interactive sibling of the read-only
 * DataTable. Fully CONTROLLED: sorting, selection, and edits are reported up
 * through callbacks; the parent owns fetching/pagination/filters and passes
 * fresh rows back down. The grid never talks to the network.
 *
 * Interactions (mirrors the Supabase Table Editor):
 * - header click cycles sort: none → asc → desc → none;
 * - leading checkbox column selects rows (header checkbox = whole page);
 * - double-click a cell to edit it in place — the editor input is chosen from
 *   the column's Postgres format (bool/enum → select, json → textarea, else
 *   text). Enter commits, Escape cancels, blur commits. "Set NULL" appears
 *   for nullable columns. Non-editable cells (PK/identity/generated) don't
 *   open an editor.
 */

export interface GridColumn {
  name: string;
  /** PostgREST format name ("uuid", "text", "int4", "timestamptz", "bool"…). */
  format: string;
  isPrimaryKey: boolean;
  isNullable: boolean;
  /** False for PK / identity / generated columns — cells render read-only. */
  isEditable: boolean;
  /** Allowed values when the column is an enum; [] otherwise. */
  enums: string[];
}

export interface GridSort {
  column: string;
  ascending: boolean;
}

/** The value shapes a cell editor can commit. Strings are cast by Postgres. */
export type GridCellValue = string | boolean | null;

export interface DataGridProps {
  columns: GridColumn[];
  rows: Array<Record<string, unknown>>;
  getRowKey: (row: Record<string, unknown>) => string;
  sort: GridSort | null;
  onSortChange: (sort: GridSort | null) => void;
  selectedKeys: ReadonlySet<string>;
  onSelectionChange: (keys: Set<string>) => void;
  /**
   * Commit a cell edit. Resolve true to keep the optimistic value (the parent
   * refetches), false to revert the cell. Absent = the whole grid is
   * read-only.
   */
  onCellEdit?: (
    row: Record<string, unknown>,
    column: GridColumn,
    value: GridCellValue,
  ) => Promise<boolean> | boolean;
  empty: string;
}

/** Compact display for any cell value; full value travels in `title`. */
export function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) return { text: "NULL", isNull: true };
  if (typeof value === "boolean") return { text: String(value), isNull: false };
  if (typeof value === "object") {
    return { text: JSON.stringify(value), isNull: false };
  }
  return { text: String(value), isNull: false };
}

const CELL_MAX = 120;

function truncate(text: string): string {
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
}

/** Initial editor text for a cell's current value. */
function editText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

interface EditingCell {
  rowKey: string;
  column: string;
}

function CellEditor({
  column,
  initial,
  onCommit,
  onCancel,
}: {
  column: GridColumn;
  initial: string;
  onCommit: (value: GridCellValue) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    null,
  );

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const keyHandler = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(e.currentTarget instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      onCommit(text);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const isJson = column.format === "json" || column.format === "jsonb";
  const isBool = column.format === "bool" || column.format === "boolean";

  return (
    <div className="dgrid-editor" onClick={(e) => e.stopPropagation()}>
      {isBool ? (
        <select
          ref={ref as React.RefObject<HTMLSelectElement>}
          className="surface control"
          aria-label={`${column.name} value`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyHandler}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : column.enums.length > 0 ? (
        <select
          ref={ref as React.RefObject<HTMLSelectElement>}
          className="surface control"
          aria-label={`${column.name} value`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyHandler}
        >
          {column.enums.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : isJson ? (
        <textarea
          ref={ref as React.RefObject<HTMLTextAreaElement>}
          className="surface control mono"
          aria-label={`${column.name} value`}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyHandler}
        />
      ) : (
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          className="surface control mono"
          aria-label={`${column.name} value`}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keyHandler}
        />
      )}
      <div className="dgrid-editor-actions">
        {column.isNullable ? (
          <button
            type="button"
            className="type-chip"
            onClick={() => onCommit(null)}
          >
            Set NULL
          </button>
        ) : null}
        <button type="button" className="type-chip" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            onCommit(
              (column.format === "bool" || column.format === "boolean")
                ? text === "true"
                : text,
            )
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function DataGrid({
  columns,
  rows,
  getRowKey,
  sort,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  onCellEdit,
  empty,
}: DataGridProps) {
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [busyCell, setBusyCell] = useState<EditingCell | null>(null);

  const cycleSort = (column: string) => {
    if (sort?.column !== column) return onSortChange({ column, ascending: true });
    if (sort.ascending) return onSortChange({ column, ascending: false });
    return onSortChange(null);
  };

  const toggleRow = (key: string) => {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  const allKeys = rows.map(getRowKey);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selectedKeys.has(k));

  const togglePage = () => {
    onSelectionChange(allSelected ? new Set() : new Set(allKeys));
  };

  const commitEdit = async (
    row: Record<string, unknown>,
    column: GridColumn,
    value: GridCellValue,
  ) => {
    if (!onCellEdit) return;
    const cell = { rowKey: getRowKey(row), column: column.name };
    setBusyCell(cell);
    try {
      await onCellEdit(row, column, value);
    } finally {
      setBusyCell(null);
      setEditing(null);
    }
  };

  return (
    <div className="surface dtable-wrap">
      <div className="dtable-scroll">
        <table className="dtable dgrid">
          <thead>
            <tr>
              <th className="dgrid-check">
                <input
                  type="checkbox"
                  aria-label="Select all rows on this page"
                  checked={allSelected}
                  onChange={togglePage}
                />
              </th>
              {columns.map((c) => (
                <th key={c.name} className="mono">
                  <button
                    type="button"
                    className="dgrid-sort"
                    aria-label={`Sort by ${c.name}`}
                    onClick={() => cycleSort(c.name)}
                  >
                    {c.name}
                    {c.isPrimaryKey ? <span className="dgrid-pk"> PK</span> : null}
                    {sort?.column === c.name ? (
                      <span aria-hidden="true">{sort.ascending ? " ▲" : " ▼"}</span>
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="dtable-empty" colSpan={columns.length + 1}>
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const key = getRowKey(row);
                return (
                  <tr key={key}>
                    <td className="dgrid-check">
                      <input
                        type="checkbox"
                        aria-label={`Select row ${key}`}
                        checked={selectedKeys.has(key)}
                        onChange={() => toggleRow(key)}
                      />
                    </td>
                    {columns.map((c) => {
                      const { text, isNull } = formatCell(row[c.name]);
                      const isEditing =
                        editing?.rowKey === key && editing.column === c.name;
                      const isBusy =
                        busyCell?.rowKey === key && busyCell.column === c.name;
                      return (
                        <td
                          key={c.name}
                          className={`mono${isBusy ? " dgrid-busy" : ""}`}
                          title={text}
                          onDoubleClick={() => {
                            if (onCellEdit && c.isEditable && !isBusy) {
                              setEditing({ rowKey: key, column: c.name });
                            }
                          }}
                        >
                          {isEditing ? (
                            <CellEditor
                              column={c}
                              initial={editText(row[c.name])}
                              onCommit={(v) => void commitEdit(row, c, v)}
                              onCancel={() => setEditing(null)}
                            />
                          ) : isNull ? (
                            <span className="dgrid-null">NULL</span>
                          ) : (
                            truncate(text)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default DataGrid;
