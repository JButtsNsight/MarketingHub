import type { ReactNode } from "react";
import { Surface } from "../Surface";

export interface Column<Row> {
  /** Stable key; also the row property read when `render` is omitted. */
  key: string;
  header: ReactNode;
  /** Render data cells in the mono (IBM Plex Mono) face — for IDs/timestamps/counts. */
  mono?: boolean;
  align?: "left" | "right";
  width?: string;
  render?: (row: Row) => ReactNode;
}

/**
 * Generic read table built on the .surface primitive (a large surface, so it
 * carries the glint). Column `render` lets callers format cells; otherwise the
 * raw `row[key]` is shown. Presentational and server-safe.
 */
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  empty,
}: {
  columns: Column<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  empty?: ReactNode;
}) {
  return (
    <Surface className="dtable-wrap" glint>
      <div className="dtable-scroll">
        <table className="dtable">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: c.align ?? "left" }}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="dtable-empty" colSpan={columns.length}>
                  {empty ?? "No rows."}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={getRowKey(row, i)}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={c.mono ? "mono" : undefined}
                      style={{ textAlign: c.align ?? "left" }}
                    >
                      {c.render
                        ? c.render(row)
                        : ((row as Record<string, unknown>)[c.key] as ReactNode)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}

export default DataTable;
