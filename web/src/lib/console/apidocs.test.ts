// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  listTables: vi.fn(),
  listColumns: vi.fn(),
}));

vi.mock("./pgmeta", () => ({
  listTables: h.listTables,
  listColumns: h.listColumns,
}));

import {
  API_DOC_SCHEMAS,
  buildSnippets,
  listApiDocEntries,
  listApiDocTables,
  type ApiDocColumn,
  type ApiDocTable,
} from "./apidocs";

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

// A non-public (marketinghub) table with an identity + a generated column.
const TEMPLATES: ApiDocTable = {
  schema: "marketinghub",
  name: "templates",
  comment: "Campaign templates",
  primaryKeys: ["id"],
  columns: [
    col({ name: "id", format: "uuid", dataType: "uuid", isPrimaryKey: true, isNullable: false }),
    col({ name: "name", isNullable: false }),
    col({ name: "kind", format: "template_kind", enums: ["email", "sms"] }),
    col({
      name: "created_at",
      format: "timestamptz",
      dataType: "timestamp with time zone",
      defaultValue: "now()",
    }),
    col({ name: "search", isGenerated: true }),
  ],
};

// A public table with an int identity PK (default schema → no profile header).
const WIDGETS: ApiDocTable = {
  schema: "public",
  name: "widgets",
  comment: null,
  primaryKeys: ["id"],
  columns: [
    col({ name: "id", format: "int8", dataType: "bigint", isPrimaryKey: true, isIdentity: true, isNullable: false }),
    col({ name: "label" }),
  ],
};

// A table with no primary key.
const EVENTS: ApiDocTable = {
  schema: "marketinghub",
  name: "events",
  comment: null,
  primaryKeys: [],
  columns: [col({ name: "payload", format: "jsonb", dataType: "jsonb" })],
};

beforeEach(() => {
  h.listTables.mockReset();
  h.listColumns.mockReset();
});

describe("listApiDocTables", () => {
  test("documents the PostgREST-exposed product schemas", () => {
    expect(API_DOC_SCHEMAS).toEqual(["marketinghub", "public"]);
  });

  test("maps pg-meta tables + columns, marking PKs and sorting by ordinal", async () => {
    h.listTables.mockResolvedValue([
      {
        id: 1,
        schema: "marketinghub",
        name: "templates",
        rls_enabled: true,
        rls_forced: false,
        live_rows_estimate: 0,
        bytes: 0,
        size: "0 kB",
        comment: "Campaign templates",
        primary_keys: [{ schema: "marketinghub", table_name: "templates", name: "id" }],
        relationships: [],
      },
    ]);
    h.listColumns.mockResolvedValue([
      { id: "1.2", table_id: 1, schema: "marketinghub", table: "templates", name: "name", ordinal_position: 2, data_type: "text", format: "text", is_nullable: false, is_identity: false, is_generated: false, is_updatable: true, default_value: null, enums: [], comment: null },
      { id: "1.1", table_id: 1, schema: "marketinghub", table: "templates", name: "id", ordinal_position: 1, data_type: "uuid", format: "uuid", is_nullable: false, is_identity: false, is_generated: false, is_updatable: true, default_value: null, enums: [], comment: null },
      // A column on a different table must not leak in.
      { id: "9.1", table_id: 9, schema: "marketinghub", table: "other", name: "x", ordinal_position: 1, data_type: "text", format: "text", is_nullable: true, is_identity: false, is_generated: false, is_updatable: true, default_value: null, enums: [], comment: null },
    ]);

    const tables = await listApiDocTables();
    expect(h.listTables).toHaveBeenCalledWith(API_DOC_SCHEMAS);
    expect(tables).toHaveLength(1);
    expect(tables[0].primaryKeys).toEqual(["id"]);
    // Sorted by ordinal_position: id (1) before name (2).
    expect(tables[0].columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(tables[0].columns[0].isPrimaryKey).toBe(true);
    expect(tables[0].columns[1].isPrimaryKey).toBe(false);
  });

  test("listApiDocEntries pairs every table with its rendered snippets", async () => {
    h.listTables.mockResolvedValue([
      {
        id: 1,
        schema: "public",
        name: "widgets",
        rls_enabled: false,
        rls_forced: false,
        live_rows_estimate: 0,
        bytes: 0,
        size: "0 kB",
        comment: null,
        primary_keys: [{ schema: "public", table_name: "widgets", name: "id" }],
        relationships: [],
      },
    ]);
    h.listColumns.mockResolvedValue([
      { id: "1.1", table_id: 1, schema: "public", table: "widgets", name: "id", ordinal_position: 1, data_type: "bigint", format: "int8", is_nullable: false, is_identity: true, is_generated: false, is_updatable: true, default_value: null, enums: [], comment: null },
    ]);

    const entries = await listApiDocEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].table.name).toBe("widgets");
    expect(entries[0].snippets.restSelect).toContain("/rest/v1/widgets");
  });
});

describe("buildSnippets — REST", () => {
  test("non-public schema uses Accept-Profile on reads and Content-Profile on writes", () => {
    const s = buildSnippets(TEMPLATES);
    expect(s.restSelect).toContain('curl "$SUPABASE_URL/rest/v1/templates?select=');
    expect(s.restSelect).toContain('-H "Accept-Profile: marketinghub"');
    expect(s.restSelect).toContain("select=id,name,kind,created_at,search");
    expect(s.restInsert).toContain("curl -X POST");
    expect(s.restInsert).toContain('-H "Content-Profile: marketinghub"');
    expect(s.restInsert).toContain('-H "Prefer: return=representation"');
    expect(s.restUpdate).toContain("curl -X PATCH");
    expect(s.restUpdate).toContain("templates?id=eq.00000000-0000-0000-0000-000000000000");
    expect(s.restDelete).toContain("curl -X DELETE");
  });

  test("public (default) schema emits no profile header", () => {
    const s = buildSnippets(WIDGETS);
    expect(s.restSelect).not.toContain("Accept-Profile");
    expect(s.restInsert).not.toContain("Content-Profile");
  });

  test("insert body excludes identity and generated columns", () => {
    const insert = buildSnippets(TEMPLATES).restInsert;
    const body = JSON.parse(insert.slice(insert.indexOf("{"), insert.lastIndexOf("}") + 1));
    // generated `search` excluded; enum sampled to its first value.
    expect(body).not.toHaveProperty("search");
    expect(body.kind).toBe("email");
    expect(body).toHaveProperty("name", "value");

    const widgetInsert = buildSnippets(WIDGETS).restInsert;
    const widgetBody = JSON.parse(
      widgetInsert.slice(widgetInsert.indexOf("{"), widgetInsert.lastIndexOf("}") + 1),
    );
    expect(widgetBody).not.toHaveProperty("id"); // identity
    expect(widgetBody).toHaveProperty("label");
  });

  test("a PK-less table falls back to the first column for update/delete", () => {
    const s = buildSnippets(EVENTS);
    expect(s.restUpdate).toContain("events?payload=eq.");
    expect(s.restDelete).toContain("events?payload=eq.");
  });
});

describe("buildSnippets — supabase-js + GraphQL", () => {
  test("supabase-js selects a non-default schema with .schema() and keys with .eq()", () => {
    const s = buildSnippets(TEMPLATES);
    expect(s.jsSelect).toContain(".schema('marketinghub')");
    expect(s.jsSelect).toContain(".from('templates')");
    expect(s.jsSelect).toContain(".select('id, name, kind, created_at, search')");
    expect(s.jsUpdate).toContain(".eq('id', '00000000-0000-0000-0000-000000000000')");
    expect(s.jsDelete).toContain(".delete()");
  });

  test("supabase-js omits .schema() for the default public schema and uses a numeric key", () => {
    const s = buildSnippets(WIDGETS);
    expect(s.jsSelect).not.toContain(".schema(");
    expect(s.jsDelete).toContain(".eq('id', 1)");
  });

  test("GraphQL renders a <table>Collection with each column as a node field", () => {
    const s = buildSnippets(TEMPLATES);
    expect(s.graphql).toContain("templatesCollection(first: 10)");
    expect(s.graphql).toContain("edges {");
    expect(s.graphql).toContain("node {");
    expect(s.graphql).toContain("        created_at");
  });
});
