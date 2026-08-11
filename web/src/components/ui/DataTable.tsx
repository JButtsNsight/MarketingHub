import type { ReactNode } from "react";
import { Surface } from "../Surface";
import { DataTablePager } from "./DataTablePager";

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

interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  getRowKey: (row: Row, index: number) => string;
  empty?: ReactNode;
  /**
   * Opt-in client-side pagination: the page size. When set AND `rows` is
   * longer, only the current page renders, followed by the Table Editor's
   * pager idiom (row count · Prev · "page x of y" · Next, same .dgrid-pager
   * classes). The page snaps back to 1 whenever `rows` changes identity, so
   * upstream filter/search always pages the filtered set. Absent (or rows
   * fit on one page) = the exact pre-existing markup.
   *
   * NOTE: the pager holds React state, so a paginating DataTable must be
   * rendered from a client component — server pages keep using the plain
   * (prop absent) form, which stays server-safe.
   */
  paginate?: number;
}

/** The pure table markup — identical between the plain and paginated paths. */
function TableSurface<Row>({
  columns,
  rows,
  getRowKey,
  empty,
}: Omit<DataTableProps<Row>, "paginate">) {
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

/**
 * Generic read table built on the .surface primitive (a large surface, so it
 * carries the glint). Column `render` lets callers format cells; otherwise the
 * raw `row[key]` is shown. Presentational and server-safe — unless `paginate`
 * kicks in (see the prop doc).
 */
export function DataTable<Row>({
  columns,
  rows,
  getRowKey,
  empty,
  paginate,
}: DataTableProps<Row>) {
  if (paginate != null && paginate > 0 && rows.length > paginate) {
    return (
      <DataTablePager total={rows.length} pageSize={paginate} resetKey={rows}>
        {(start, end) => (
          <TableSurface
            columns={columns}
            rows={rows.slice(start, end)}
            // Absolute index, so index-based keys stay unique across pages.
            getRowKey={(row, i) => getRowKey(row, start + i)}
            empty={empty}
          />
        )}
      </DataTablePager>
    );
  }
  return (
    <TableSurface columns={columns} rows={rows} getRowKey={getRowKey} empty={empty} />
  );
}

export default DataTable;
