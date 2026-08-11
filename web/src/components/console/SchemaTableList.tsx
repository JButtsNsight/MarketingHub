"use client";

import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { DataTablePager } from "../ui/DataTablePager";
import type { EditorColumn, EditorTable } from "@/lib/console/tables";

/**
 * One schema's table sections on the Schema page — each table renders its own
 * columns sub-table, so on a real database the section used to scroll
 * forever. This client island pages the TABLE SECTIONS (the unbounded
 * dimension) with the Table Editor's pager idiom via DataTablePager; each
 * table's column list additionally paginates at 50 (very wide tables only).
 * The data (EditorTable) is plain JSON from the server page's introspection.
 */

const TABLES_PER_PAGE = 10;

const COLUMN_COLUMNS: Column<EditorColumn>[] = [
  {
    key: "name",
    header: "column",
    mono: true,
    render: (c) => (
      <>
        {c.name}{" "}
        {c.isPrimaryKey ? <Badge tone="var(--data-1)">PK</Badge> : null}
      </>
    ),
  },
  { key: "dataType", header: "type", mono: true, width: "220px", render: (c) => c.dataType },
  {
    key: "nullable",
    header: "nullable",
    width: "90px",
    render: (c) => (c.isNullable ? "yes" : "no"),
  },
  {
    key: "default",
    header: "default",
    mono: true,
    render: (c) =>
      c.defaultValue ? (
        <span title={c.defaultValue}>
          {c.defaultValue.length > 48
            ? `${c.defaultValue.slice(0, 47)}…`
            : c.defaultValue}
        </span>
      ) : (
        "—"
      ),
  },
];

export function SchemaTableList({ tables }: { tables: EditorTable[] }) {
  const sections = (start: number, end: number) => (
    <div className="stack">
      {tables.slice(start, end).map((t) => (
        <div key={`${t.schema}.${t.name}`}>
          <p className="eyebrow">
            {t.name}{" "}
            <span className="mono">
              · {t.rowsEstimate.toLocaleString()} rows · {t.size}
            </span>
          </p>
          <DataTable
            columns={COLUMN_COLUMNS}
            rows={t.columns}
            getRowKey={(c) => c.name}
            empty="No columns."
            paginate={50}
          />
        </div>
      ))}
    </div>
  );

  if (tables.length <= TABLES_PER_PAGE) return sections(0, tables.length);

  return (
    <DataTablePager
      total={tables.length}
      pageSize={TABLES_PER_PAGE}
      resetKey={tables}
      noun="table"
    >
      {sections}
    </DataTablePager>
  );
}

export default SchemaTableList;
