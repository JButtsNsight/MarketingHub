import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TableEditor, type EditorTableDto } from "./TableEditor";

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

const TEMPLATES: EditorTableDto = {
  schema: "marketinghub",
  name: "templates",
  rowsEstimate: 8,
  size: "96 kB",
  rlsEnabled: true,
  comment: null,
  primaryKeys: ["id"],
  sensitive: false,
  columns: [
    column({ name: "id", format: "uuid", isPrimaryKey: true, isNullable: false }),
    column({ name: "name" }),
  ],
};

const OUTBOX: EditorTableDto = {
  ...TEMPLATES,
  name: "sms_campaign_recipients",
  sensitive: true,
};

/** Route-aware fetch mock: GET rows, DELETE rows, POST insert. */
function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/console/rows") && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            rows: [
              { id: "r1", name: "Alpha" },
              { id: "r2", name: "Beta" },
            ],
            total: 2,
          }),
          { status: 200 },
        ),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ deleted: 1 }), { status: 200 }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ row: { id: "r3" } }), { status: 201 }),
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

describe("TableEditor", () => {
  test("selects the first marketinghub table, fetches its rows, renders the grid", async () => {
    const { calls } = mockFetchRoutes();
    render(<TableEditor initialTables={[TEMPLATES, OUTBOX]} />);

    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(calls[0].url).toContain("schema=marketinghub");
    expect(calls[0].url).toContain("table=templates");
    expect(screen.getByText("marketinghub.templates")).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
    // no warning banner on a non-sensitive table
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("switching to a sensitive table shows the outbox warning", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[TEMPLATES, OUTBOX]} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(
      screen.getByRole("button", { name: /sms_campaign_recipients/ }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/at-most-once/i),
    );
  });

  test("adding a filter refetches with the filters param and resets to page 1", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[TEMPLATES]} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText("Filter column"), "name");
    await user.selectOptions(screen.getByLabelText("Filter operator"), "ilike");
    await user.type(screen.getByLabelText("Filter value"), "%alpha%");
    await user.click(screen.getByRole("button", { name: "Add filter" }));

    await waitFor(() => {
      const last = calls[calls.length - 1].url;
      expect(last).toContain("filters=");
      expect(decodeURIComponent(last)).toContain('"ilike"');
    });
  });

  test("delete is two-step and sends the selected PKs", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[TEMPLATES]} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: "Select row r1" }));
    await user.click(screen.getByRole("button", { name: "Delete 1 selected" }));
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm delete 1" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        schema: "marketinghub",
        table: "templates",
        keys: [{ id: "r1" }],
      });
    });
  });

  test("insert panel omits blanks, honors NULL checkboxes, and POSTs", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<TableEditor initialTables={[TEMPLATES]} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Insert row" }));
    await user.type(screen.getByLabelText(/^name/), "Gamma");
    await user.click(screen.getByRole("button", { name: "Insert row" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post!.init!.body as string)).toEqual({
        schema: "marketinghub",
        table: "templates",
        values: { name: "Gamma" },
      });
    });
  });
});
