import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SchemaDesignerCanvas,
  cardHeight,
  computeDesignerLayout,
  edgePath,
  tableKey,
  type DesignerEdge,
  type DesignerTable,
} from "./SchemaDesignerCanvas";

const CONTACTS: DesignerTable = {
  schema: "marketinghub",
  name: "contacts",
  rowsEstimate: 1200,
  columns: [
    { name: "id", dataType: "uuid", isPrimaryKey: true, isForeignKey: false, isNullable: false },
    { name: "phone", dataType: "text", isPrimaryKey: false, isForeignKey: false, isNullable: false },
  ],
};

const CAMPAIGNS: DesignerTable = {
  schema: "marketinghub",
  name: "sms_campaigns",
  rowsEstimate: 42,
  columns: [
    { name: "id", dataType: "uuid", isPrimaryKey: true, isForeignKey: false, isNullable: false },
    { name: "name", dataType: "text", isPrimaryKey: false, isForeignKey: false, isNullable: true },
  ],
};

const RECIPIENTS: DesignerTable = {
  schema: "marketinghub",
  name: "sms_campaign_recipients",
  rowsEstimate: 9000,
  columns: [
    { name: "id", dataType: "uuid", isPrimaryKey: true, isForeignKey: false, isNullable: false },
    { name: "campaign_id", dataType: "uuid", isPrimaryKey: false, isForeignKey: true, isNullable: false },
    { name: "contact_id", dataType: "uuid", isPrimaryKey: false, isForeignKey: true, isNullable: false },
  ],
};

const PUBLIC_TABLE: DesignerTable = {
  schema: "public",
  name: "notes",
  rowsEstimate: 3,
  columns: [
    { name: "id", dataType: "int8", isPrimaryKey: true, isForeignKey: false, isNullable: false },
  ],
};

const EDGES: DesignerEdge[] = [
  {
    id: "recipients_campaign_fk",
    sourceSchema: "marketinghub",
    sourceTable: "sms_campaign_recipients",
    sourceColumn: "campaign_id",
    targetSchema: "marketinghub",
    targetTable: "sms_campaigns",
    targetColumn: "id",
  },
  {
    id: "recipients_contact_fk",
    sourceSchema: "marketinghub",
    sourceTable: "sms_campaign_recipients",
    sourceColumn: "contact_id",
    targetSchema: "marketinghub",
    targetTable: "contacts",
    targetColumn: "id",
  },
];

const TABLES = [CONTACTS, CAMPAIGNS, RECIPIENTS, PUBLIC_TABLE];

describe("computeDesignerLayout", () => {
  test("places every table with a non-overlapping box and sizes the canvas", () => {
    const { positions, width, height } = computeDesignerLayout(TABLES);
    for (const t of TABLES) {
      const box = positions[tableKey(t.schema, t.name)];
      expect(box).toBeDefined();
      expect(box.h).toBe(cardHeight(t.columns.length));
    }
    // 4 tables => 2-wide grid; canvas spans past both columns.
    expect(width).toBeGreaterThan(200);
    expect(height).toBeGreaterThan(200);
  });

  test("empty input yields a zero-size canvas", () => {
    expect(computeDesignerLayout([])).toEqual({ positions: {}, width: 0, height: 0 });
  });
});

describe("edgePath", () => {
  test("draws a self-loop when source and target box are identical", () => {
    const box = { x: 0, y: 0, w: 248, h: 100 };
    const loop = edgePath(box, box);
    const between = edgePath(box, { x: 400, y: 0, w: 248, h: 100 });
    expect(loop).toMatch(/^M /);
    expect(loop).not.toEqual(between);
  });
});

describe("SchemaDesignerCanvas", () => {
  test("renders a card per table with PK/FK badges and one path per edge", () => {
    render(<SchemaDesignerCanvas tables={TABLES} edges={EDGES} />);

    expect(screen.getByText("contacts")).toBeInTheDocument();
    expect(screen.getByText("sms_campaigns")).toBeInTheDocument();
    expect(screen.getByText("sms_campaign_recipients")).toBeInTheDocument();

    // PK on every table, FK only on the join table's two ref columns.
    expect(screen.getAllByText("PK").length).toBe(4);
    expect(screen.getAllByText("FK").length).toBe(2);

    const paths = document.querySelectorAll("path[data-edge-id]");
    expect(paths.length).toBe(EDGES.length);
  });

  test("is read-only: no write controls or confirm dialog exist", () => {
    render(<SchemaDesignerCanvas tables={TABLES} edges={EDGES} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /drop|create|delete|save|alter/i })).toBeNull();
  });

  test("selecting a table focuses it, dims unrelated tables, and de-emphasises unrelated edges", async () => {
    const user = userEvent.setup();
    render(<SchemaDesignerCanvas tables={TABLES} edges={EDGES} />);

    const recipientsCard = document.querySelector(
      '[data-table-key="marketinghub.sms_campaign_recipients"]',
    ) as HTMLElement;
    await user.click(recipientsCard);

    expect(recipientsCard).toHaveAttribute("aria-pressed", "true");

    // contacts is a neighbour (kept), the unrelated public table is dimmed.
    const contactsCard = document.querySelector(
      '[data-table-key="marketinghub.contacts"]',
    ) as HTMLElement;
    const notesCard = document.querySelector(
      '[data-table-key="public.notes"]',
    ) as HTMLElement;
    expect(contactsCard).toHaveAttribute("data-dim", "false");
    expect(notesCard).toHaveAttribute("data-dim", "true");

    // Both edges touch the recipients join table, so both stay active.
    const active = document.querySelectorAll('path[data-active="true"]');
    expect(active.length).toBe(2);

    // A "Clear focus" affordance appears once something is selected.
    const clear = screen.getByRole("button", { name: "Clear focus" });
    await user.click(clear);
    expect(recipientsCard).toHaveAttribute("aria-pressed", "false");
  });

  test("toggling a schema chip hides that schema's tables and re-lays out", async () => {
    const user = userEvent.setup();
    render(<SchemaDesignerCanvas tables={TABLES} edges={EDGES} />);

    expect(screen.getByText("notes")).toBeInTheDocument();
    const publicChip = document.querySelector('[data-schema="public"]') as HTMLElement;
    expect(publicChip).toHaveAttribute("aria-pressed", "true");
    await user.click(publicChip);
    expect(screen.queryByText("notes")).not.toBeInTheDocument();
    // marketinghub tables remain.
    expect(screen.getByText("contacts")).toBeInTheDocument();
  });

  test("renders an explicit empty state when there are no tables", () => {
    render(<SchemaDesignerCanvas tables={[]} edges={[]} />);
    expect(screen.getByText("Nothing to diagram")).toBeInTheDocument();
  });
});
