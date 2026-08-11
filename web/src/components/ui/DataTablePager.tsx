"use client";

import { useState, type ReactNode } from "react";

/**
 * Client-side page state behind DataTable's opt-in `paginate` prop — also
 * reusable by custom lists (e.g. the Schema page's per-table sections) that
 * want the Table Editor's pager idiom. Renders `children` for the current
 * [start, end) window, then the footer pager using the SAME markup/classes as
 * the Table Editor's DataGrid pager (.dgrid-pager container, .type-chip
 * Prev/Next, "page x of y", row count) — no new styles.
 *
 * The page snaps back to 1 whenever `resetKey` changes identity: callers pass
 * their row array, so upstream filter/search producing a new array resets the
 * window (pagination always applies to the filtered set).
 */
export function DataTablePager({
  total,
  pageSize,
  resetKey,
  noun = "row",
  children,
}: {
  /** Total item count across all pages. */
  total: number;
  pageSize: number;
  /** Identity of the underlying data — page 1 again when it changes. */
  resetKey: unknown;
  /** Singular noun for the count readout ("row" → "1,204 rows"). */
  noun?: string;
  children: (start: number, end: number) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  // Derived-state reset (not an effect): snap to page 1 in the same render
  // that sees the new data, so a stale window never paints.
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setPage(0);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;

  return (
    <>
      {children(start, Math.min(start + pageSize, total))}
      <div className="dgrid-pager">
        <span>
          {total.toLocaleString()} {noun}
          {total === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="type-chip"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          Prev
        </button>
        <span>
          page {current + 1} of {pageCount}
        </span>
        <button
          type="button"
          className="type-chip"
          disabled={current + 1 >= pageCount}
          onClick={() => setPage(current + 1)}
        >
          Next
        </button>
      </div>
    </>
  );
}

export default DataTablePager;
