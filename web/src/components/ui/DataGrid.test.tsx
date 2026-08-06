import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataGrid, formatCell, type GridColumn } from "./DataGrid";

const COLUMNS: GridColumn[] = [
  {
    name: "id",
    format: "uuid",
    isPrimaryKey: true,
    isNullable: false,
    isEditable: false,
    enums: [],
  },
  {
    name: "name",
    format: "text",
    isPrimaryKey: false,
    isNullable: true,
    isEditable: true,
    enums: [],
  },
  {
    name: "active",
    format: "bool",
    isPrimaryKey: false,
    isNullable: false,
    isEditable: true,
    enums: [],
  },
];

const ROWS = [
  { id: "r1", name: "Alpha", active: true },
  { id: "r2", name: null, active: false },
];

function renderGrid(over: Partial<React.ComponentProps<typeof DataGrid>> = {}) {
  const props: React.ComponentProps<typeof DataGrid> = {
    columns: COLUMNS,
    rows: ROWS,
    getRowKey: (r) => String(r.id),
    sort: null,
    onSortChange: vi.fn(),
    selectedKeys: new Set<string>(),
    onSelectionChange: vi.fn(),
    onCellEdit: vi.fn().mockResolvedValue(true),
    empty: "No rows.",
    ...over,
  };
  render(<DataGrid {...props} />);
  return props;
}

describe("formatCell", () => {
  test("NULL, booleans, objects, and scalars", () => {
    expect(formatCell(null)).toEqual({ text: "NULL", isNull: true });
    expect(formatCell(undefined)).toEqual({ text: "NULL", isNull: true });
    expect(formatCell(true)).toEqual({ text: "true", isNull: false });
    expect(formatCell({ a: 1 })).toEqual({ text: '{"a":1}', isNull: false });
    expect(formatCell(42)).toEqual({ text: "42", isNull: false });
  });
});

describe("DataGrid", () => {
  test("renders rows with PK markers and NULL pills", () => {
    renderGrid();
    expect(screen.getByText("PK")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  test("header click cycles sort none → asc → desc → none", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderGrid({ onSortChange });

    await user.click(screen.getByRole("button", { name: "Sort by name" }));
    expect(onSortChange).toHaveBeenLastCalledWith({
      column: "name",
      ascending: true,
    });

    renderGrid({ onSortChange, sort: { column: "name", ascending: true } });
    await user.click(
      screen.getAllByRole("button", { name: "Sort by name" })[1],
    );
    expect(onSortChange).toHaveBeenLastCalledWith({
      column: "name",
      ascending: false,
    });

    renderGrid({ onSortChange, sort: { column: "name", ascending: false } });
    await user.click(
      screen.getAllByRole("button", { name: "Sort by name" })[2],
    );
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  test("row and page selection report up", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderGrid({ onSelectionChange });

    await user.click(screen.getByRole("checkbox", { name: "Select row r1" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(["r1"]));

    await user.click(
      screen.getByRole("checkbox", { name: "Select all rows on this page" }),
    );
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(["r1", "r2"]));
  });

  test("double-click opens the editor; Save commits the new value", async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn().mockResolvedValue(true);
    renderGrid({ onCellEdit });

    await user.dblClick(screen.getByText("Alpha"));
    const input = screen.getByRole("textbox", { name: "name value" });
    await user.clear(input);
    await user.type(input, "Beta");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onCellEdit).toHaveBeenCalledWith(
      ROWS[0],
      expect.objectContaining({ name: "name" }),
      "Beta",
    );
  });

  test("Set NULL commits null for nullable columns", async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn().mockResolvedValue(true);
    renderGrid({ onCellEdit });

    await user.dblClick(screen.getByText("Alpha"));
    await user.click(screen.getByRole("button", { name: "Set NULL" }));

    expect(onCellEdit).toHaveBeenCalledWith(
      ROWS[0],
      expect.objectContaining({ name: "name" }),
      null,
    );
  });

  test("bool columns edit through a select and commit real booleans", async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn().mockResolvedValue(true);
    renderGrid({ onCellEdit });

    await user.dblClick(screen.getAllByText("true")[0]);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "active value" }),
      "false",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onCellEdit).toHaveBeenCalledWith(
      ROWS[0],
      expect.objectContaining({ name: "active" }),
      false,
    );
  });

  test("Escape cancels without committing", async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    renderGrid({ onCellEdit });

    await user.dblClick(screen.getByText("Alpha"));
    await user.keyboard("{Escape}");

    expect(onCellEdit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "name value" }),
    ).not.toBeInTheDocument();
  });

  test("non-editable (PK) cells never open an editor", async () => {
    const user = userEvent.setup();
    const onCellEdit = vi.fn();
    renderGrid({ onCellEdit });

    await user.dblClick(screen.getByText("r1"));
    expect(
      screen.queryByRole("textbox", { name: "id value" }),
    ).not.toBeInTheDocument();
  });

  test("empty rows render the empty message", () => {
    renderGrid({ rows: [] });
    expect(screen.getByText("No rows.")).toBeInTheDocument();
  });
});
