import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TableEditor, type EditorTableDto } from "./TableEditor";

/**
 * FK-selector behaviour: for a column that is a foreign key, the editor renders
 * a row-picker (dropdown of referenced rows) instead of a free-text cell — in
 * both the insert panel and the grid's inline editor. Candidate rows come from
 * /api/console/fk-options; a non-FK column stays a plain field.
 */

function column(over: Partial<EditorTableDto["columns"][0]> = {}) {
  return {
    name: "name",
    dataType: "text",
    format: "text",
    isNullable: true,
    isPrimaryKey: false,
    isEditable: true,
    defaultValue: null,
    enums: [],
    comment: null,
    ...over,
  };
}

const CAMPAIGNS: EditorTableDto = {
  schema: "marketinghub",
  name: "campaigns",
  rowsEstimate: 1,
  size: "16 kB",
  rlsEnabled: false,
  comment: null,
  primaryKeys: ["id"],
  sensitive: false,
  columns: [
    column({ name: "id", format: "uuid", isPrimaryKey: true, isEditable: false, isNullable: false }),
    column({ name: "template_id", format: "uuid" }),
    column({ name: "name" }),
  ],
  // Supplied on the DTO, so the editor uses it directly (no relationships fetch).
  relationships: [
    {
      column: "template_id",
      targetSchema: "marketinghub",
      targetTable: "templates",
      targetColumn: "id",
    },
  ],
};

function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/console/fk-options") && url.includes("column=template_id")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            column: "template_id",
            target: {
              schema: "marketinghub",
              table: "templates",
              valueColumn: "id",
              displayColumn: "name",
            },
            options: [
              { value: "t1", label: "Alpha · t1" },
              { value: "t2", label: "Beta · t2" },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.startsWith("/api/console/rows") && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rows: [{ id: "r1", template_id: "t1", name: "Row one" }],
            total: 1,
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TableEditor FK selector", () => {
  test("insert panel renders a labelled row-picker for the FK column, a plain field otherwise", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[CAMPAIGNS]} />);
    await waitFor(() => expect(screen.getByText("Row one")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Insert row" }));

    // The FK column offers the referenced rows with their display-column labels.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Alpha · t1" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: "Beta · t2" })).toBeInTheDocument();

    const fkControl = screen.getByLabelText(/^template_id/);
    expect(fkControl.tagName).toBe("SELECT");
    // A non-FK, non-enum column stays a free-text input.
    expect((screen.getByLabelText(/^name/) as HTMLElement).tagName).toBe("INPUT");
  });

  test("double-clicking an FK cell opens a dropdown, not a text box", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[CAMPAIGNS]} />);
    await waitFor(() => expect(screen.getByText("Row one")).toBeInTheDocument());

    await user.dblClick(screen.getByText("t1"));

    // Once the options arrive the inline editor is a <select> (combobox), so the
    // FK cell is a picker rather than the default free-text input.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "template_id value" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("option", { name: "t1" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "t2" })).toBeInTheDocument();
  });
});
