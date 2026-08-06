// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as unknown,
  listTables: vi.fn(),
  listColumns: vi.fn(),
}));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));
vi.mock("./pgmeta", () => ({
  listTables: h.listTables,
  listColumns: h.listColumns,
}));

import {
  deleteRows,
  getEditorTable,
  getRows,
  insertRow,
  listEditorTables,
  updateRow,
  type EditorTable,
} from "./tables";

/** Chainable-thenable PostgREST mock (same shape as the sms repo tests). */
interface QueryLog {
  schema: string | null;
  table: string;
  select: string | null;
  selectOptions: unknown;
  insert: unknown;
  update: unknown;
  delete: boolean;
  filter: Array<[string, string, unknown]>;
  is: Array<[string, unknown]>;
  not: Array<[string, string, unknown]>;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  order: Array<[string, unknown]>;
  range: [number, number] | null;
  single: boolean;
  maybeSingle: boolean;
}

type MockResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};
const ok = (data: unknown, count?: number): MockResult => ({
  data,
  error: null,
  count: count ?? null,
});
const err = (message: string): MockResult => ({ data: null, error: { message } });

function buildClient(results: MockResult[] = []) {
  const queries: QueryLog[] = [];
  let next = 0;
  let currentSchema: string | null = null;

  const from = vi.fn((table: string) => {
    const log: QueryLog = {
      schema: currentSchema,
      table,
      select: null,
      selectOptions: null,
      insert: null,
      update: null,
      delete: false,
      filter: [],
      is: [],
      not: [],
      eq: [],
      in: [],
      order: [],
      range: null,
      single: false,
      maybeSingle: false,
    };
    queries.push(log);
    const result = results[next++] ?? { data: null, error: null };
    const q: Record<string, unknown> = {};
    q.select = vi.fn((cols?: string, options?: unknown) => {
      log.select = cols ?? "*";
      log.selectOptions = options ?? null;
      return q;
    });
    q.insert = vi.fn((rows: unknown) => ((log.insert = rows), q));
    q.update = vi.fn((row: unknown) => ((log.update = row), q));
    q.delete = vi.fn(() => ((log.delete = true), q));
    q.filter = vi.fn((c: string, op: string, v: unknown) => (log.filter.push([c, op, v]), q));
    q.is = vi.fn((c: string, v: unknown) => (log.is.push([c, v]), q));
    q.not = vi.fn((c: string, op: string, v: unknown) => (log.not.push([c, op, v]), q));
    q.eq = vi.fn((c: string, v: unknown) => (log.eq.push([c, v]), q));
    q.in = vi.fn((c: string, v: unknown[]) => (log.in.push([c, v]), q));
    q.order = vi.fn((c: string, o: unknown) => (log.order.push([c, o]), q));
    q.range = vi.fn((a: number, b: number) => ((log.range = [a, b]), q));
    q.single = vi.fn(() => ((log.single = true), Promise.resolve(result)));
    q.maybeSingle = vi.fn(() => ((log.maybeSingle = true), Promise.resolve(result)));
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return q;
  });
  const schema = vi.fn((s: string) => ((currentSchema = s), { from }));
  return { client: { schema }, queries };
}

const PG_TABLES = [
  {
    id: 1,
    schema: "marketinghub",
    name: "templates",
    rls_enabled: true,
    rls_forced: true,
    live_rows_estimate: 8,
    bytes: 98304,
    size: "96 kB",
    comment: null,
    primary_keys: [{ schema: "marketinghub", table_name: "templates", name: "id" }],
    relationships: [],
  },
  {
    id: 2,
    schema: "marketinghub",
    name: "sms_campaign_recipients",
    rls_enabled: true,
    rls_forced: true,
    live_rows_estimate: 120,
    bytes: 1,
    size: "8 kB",
    comment: null,
    primary_keys: [
      { schema: "marketinghub", table_name: "sms_campaign_recipients", name: "id" },
    ],
    relationships: [],
  },
];

const PG_COLUMNS = [
  {
    id: "1.1",
    table_id: 1,
    schema: "marketinghub",
    table: "templates",
    name: "id",
    ordinal_position: 1,
    data_type: "uuid",
    format: "uuid",
    is_nullable: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    default_value: "gen_random_uuid()",
    enums: [],
    comment: null,
  },
  {
    id: "1.2",
    table_id: 1,
    schema: "marketinghub",
    table: "templates",
    name: "name",
    ordinal_position: 2,
    data_type: "text",
    format: "text",
    is_nullable: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    default_value: null,
    enums: [],
    comment: null,
  },
  {
    id: "2.1",
    table_id: 2,
    schema: "marketinghub",
    table: "sms_campaign_recipients",
    name: "id",
    ordinal_position: 1,
    data_type: "uuid",
    format: "uuid",
    is_nullable: false,
    is_identity: false,
    is_generated: false,
    is_updatable: true,
    default_value: null,
    enums: [],
    comment: null,
  },
];

beforeEach(() => {
  h.listTables.mockReset().mockResolvedValue(PG_TABLES);
  h.listColumns.mockReset().mockResolvedValue(PG_COLUMNS);
});

function templatesMeta(): Promise<EditorTable | null> {
  return getEditorTable("marketinghub", "templates");
}

describe("listEditorTables / getEditorTable", () => {
  test("merges tables with their columns and flags sensitive tables", async () => {
    const tables = await listEditorTables();
    expect(tables.map((t) => t.name)).toEqual([
      "sms_campaign_recipients",
      "templates",
    ]);
    const outbox = tables[0];
    expect(outbox.sensitive).toBe(true);
    expect(outbox.primaryKeys).toEqual(["id"]);
    const templates = tables[1];
    expect(templates.sensitive).toBe(false);
    expect(templates.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(templates.columns[0].isPrimaryKey).toBe(true);
  });

  test("getEditorTable refuses schemas outside the editor set", async () => {
    expect(await getEditorTable("pg_catalog", "pg_class")).toBeNull();
    expect(h.listTables).not.toHaveBeenCalled();
  });

  test("getEditorTable returns null for an unknown table", async () => {
    expect(await getEditorTable("marketinghub", "nope")).toBeNull();
  });
});

describe("getRows", () => {
  test("applies filters, sort, and range; returns rows + exact count", async () => {
    const { client, queries } = buildClient([ok([{ id: "a" }], 42)]);
    h.client = client;
    const meta = (await templatesMeta())!;

    const page = await getRows(meta, {
      page: 2,
      pageSize: 25,
      sort: { column: "name", ascending: false },
      filters: [
        { column: "name", op: "ilike", value: "%promo%" },
        { column: "name", op: "is", value: "not.null" },
      ],
    });

    expect(page).toEqual({ rows: [{ id: "a" }], total: 42 });
    const q = queries[0];
    expect(q.schema).toBe("marketinghub");
    expect(q.table).toBe("templates");
    expect(q.selectOptions).toEqual({ count: "exact" });
    expect(q.filter).toContainEqual(["name", "ilike", "%promo%"]);
    expect(q.not).toContainEqual(["name", "is", null]);
    expect(q.order).toContainEqual(["name", { ascending: false }]);
    expect(q.range).toEqual([50, 74]);
  });

  test("defaults to PK ordering for stable pagination when unsorted", async () => {
    const { client, queries } = buildClient([ok([], 0)]);
    h.client = client;
    const meta = (await templatesMeta())!;

    await getRows(meta, { page: 0, pageSize: 50, sort: null, filters: [] });
    expect(queries[0].order).toContainEqual(["id", { ascending: true }]);
  });

  test("fails loud on an unknown sort/filter column", async () => {
    h.client = buildClient([]).client;
    const meta = (await templatesMeta())!;
    await expect(
      getRows(meta, {
        page: 0,
        pageSize: 50,
        sort: { column: "evil", ascending: true },
        filters: [],
      }),
    ).rejects.toThrow(/unknown column/);
  });
});

describe("mutations", () => {
  test("insertRow validates columns and returns the created row", async () => {
    const { client, queries } = buildClient([ok({ id: "new" })]);
    h.client = client;
    const meta = (await templatesMeta())!;

    const row = await insertRow(meta, { name: "Hello" });
    expect(row).toEqual({ id: "new" });
    expect(queries[0].insert).toEqual({ name: "Hello" });

    await expect(insertRow(meta, { nope: 1 })).rejects.toThrow(/unknown column/);
  });

  test("updateRow requires the FULL primary key and addresses by it", async () => {
    const { client, queries } = buildClient([ok({ id: "a", name: "New" })]);
    h.client = client;
    const meta = (await templatesMeta())!;

    const row = await updateRow(meta, { id: "a" }, { name: "New" });
    expect(row).toEqual({ id: "a", name: "New" });
    expect(queries[0].update).toEqual({ name: "New" });
    expect(queries[0].eq).toContainEqual(["id", "a"]);

    await expect(updateRow(meta, {}, { name: "x" })).rejects.toThrow(
      /incomplete primary key/,
    );
  });

  test("deleteRows uses one .in() for single-column PKs and reports the count", async () => {
    const { client, queries } = buildClient([ok([{ id: "a" }, { id: "b" }])]);
    h.client = client;
    const meta = (await templatesMeta())!;

    const deleted = await deleteRows(meta, [{ id: "a" }, { id: "b" }]);
    expect(deleted).toBe(2);
    expect(queries[0].delete).toBe(true);
    expect(queries[0].in).toContainEqual(["id", ["a", "b"]]);
  });

  test("Postgres errors surface with the [console:tables] prefix", async () => {
    h.client = buildClient([err("violates not-null constraint")]).client;
    const meta = (await templatesMeta())!;
    await expect(insertRow(meta, { name: "x" })).rejects.toThrow(
      /\[console:tables\].*not-null/,
    );
  });
});
