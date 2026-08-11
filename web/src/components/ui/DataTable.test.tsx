import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable, type Column } from "./DataTable";

interface Row {
  id: string;
  name: string;
}

const COLUMNS: Column<Row>[] = [
  { key: "id", header: "id", mono: true },
  { key: "name", header: "name" },
];

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, name: `Row ${i + 1}` }));

describe("DataTable", () => {
  test("renders every row and no pager when paginate is absent", () => {
    render(
      <DataTable columns={COLUMNS} rows={makeRows(60)} getRowKey={(r) => r.id} />,
    );
    expect(screen.getByText("Row 1")).toBeInTheDocument();
    expect(screen.getByText("Row 60")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByText(/page 1 of/)).not.toBeInTheDocument();
  });

  test("renders the empty state (paginate set, zero rows)", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(r) => r.id}
        empty="Nothing here."
        paginate={50}
      />,
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  test("no pager when the rows fit on a single page", () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={makeRows(50)}
        getRowKey={(r) => r.id}
        paginate={50}
      />,
    );
    expect(screen.getByText("Row 50")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  test("paginates long lists: window, counts, prev/next", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={COLUMNS}
        rows={makeRows(120)}
        getRowKey={(r) => r.id}
        paginate={50}
      />,
    );

    // First page: rows 1–50, count + position readouts, Prev disabled.
    expect(screen.getByText("Row 1")).toBeInTheDocument();
    expect(screen.getByText("Row 50")).toBeInTheDocument();
    expect(screen.queryByText("Row 51")).not.toBeInTheDocument();
    expect(screen.getByText("120 rows")).toBeInTheDocument();
    expect(screen.getByText("page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("page 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Row 51")).toBeInTheDocument();
    expect(screen.queryByText("Row 50")).not.toBeInTheDocument();

    // Last page: 20 remaining rows, Next disabled.
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("page 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Row 120")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Prev" }));
    expect(screen.getByText("page 2 of 3")).toBeInTheDocument();
  });

  test("page resets when the row data identity changes (upstream filter/search)", async () => {
    const user = userEvent.setup();
    const first = makeRows(120);
    const { rerender } = render(
      <DataTable columns={COLUMNS} rows={first} getRowKey={(r) => r.id} paginate={50} />,
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("page 2 of 3")).toBeInTheDocument();

    // Same rows re-passed by identity — the page must be kept.
    rerender(
      <DataTable columns={COLUMNS} rows={first} getRowKey={(r) => r.id} paginate={50} />,
    );
    expect(screen.getByText("page 2 of 3")).toBeInTheDocument();

    // A NEW array (as a filter/search upstream would produce) resets to page 1.
    const filtered = first.slice(0, 70);
    rerender(
      <DataTable
        columns={COLUMNS}
        rows={filtered}
        getRowKey={(r) => r.id}
        paginate={50}
      />,
    );
    expect(screen.getByText("page 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("70 rows")).toBeInTheDocument();
    expect(screen.getByText("Row 1")).toBeInTheDocument();
  });
});
