import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiDocsClient } from "./ApiDocsClient";
import { toApiDocEntry, type ApiDocColumn, type ApiDocTable } from "@/lib/console/apidocs";

function col(partial: Partial<ApiDocColumn> & { name: string }): ApiDocColumn {
  return {
    dataType: "text",
    format: "text",
    isNullable: true,
    isPrimaryKey: false,
    isIdentity: false,
    isGenerated: false,
    defaultValue: null,
    enums: [],
    comment: null,
    ...partial,
  };
}

const TEMPLATES: ApiDocTable = {
  schema: "marketinghub",
  name: "templates",
  comment: "Campaign templates",
  primaryKeys: ["id"],
  columns: [
    col({ name: "id", format: "uuid", isPrimaryKey: true, isNullable: false }),
    col({ name: "name", isNullable: false }),
  ],
};

const WIDGETS: ApiDocTable = {
  schema: "public",
  name: "widgets",
  comment: null,
  primaryKeys: ["id"],
  columns: [
    col({ name: "id", format: "int8", isPrimaryKey: true, isIdentity: true, isNullable: false }),
    col({ name: "label" }),
  ],
};

const ENTRIES = [TEMPLATES, WIDGETS].map(toApiDocEntry);

describe("ApiDocsClient", () => {
  test("renders the first table's docs and is entirely read-only (no confirm modal)", () => {
    render(<ApiDocsClient entries={ENTRIES} />);

    // Schema section title + column table.
    expect(screen.getByRole("heading", { name: "marketinghub.templates" })).toBeInTheDocument();
    expect(screen.getByText("Campaign templates")).toBeInTheDocument();
    // Default language is cURL; a non-public schema needs Accept-Profile.
    expect(document.body.textContent).toContain("Accept-Profile: marketinghub");
    expect(document.body.textContent).toContain("/rest/v1/templates");
    // Read-only surface: nothing pops an interrupting confirm.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("switching the table selector re-renders for the chosen table", async () => {
    const user = userEvent.setup();
    render(<ApiDocsClient entries={ENTRIES} />);

    await user.selectOptions(screen.getByLabelText("Table"), "public.widgets");

    expect(screen.getByRole("heading", { name: "public.widgets" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("/rest/v1/widgets");
    // public is the default profile — no Accept-Profile header.
    expect(document.body.textContent).not.toContain("Accept-Profile");
  });

  test("the language toggle swaps the example set (cURL → JavaScript → GraphQL)", async () => {
    const user = userEvent.setup();
    render(<ApiDocsClient entries={ENTRIES} />);

    await user.click(screen.getByRole("button", { name: "JavaScript" }));
    expect(document.body.textContent).toContain(".schema('marketinghub')");
    expect(document.body.textContent).toContain(".from('templates')");

    await user.click(screen.getByRole("button", { name: "GraphQL" }));
    expect(document.body.textContent).toContain("templatesCollection(first: 10)");
  });
});
