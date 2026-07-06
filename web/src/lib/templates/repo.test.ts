import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  createTemplate,
  getTemplate,
  listTemplates,
  searchTemplates,
} from "./repo";

interface Calls {
  schema: string | null;
  from: string | null;
  insert: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  order: [string, unknown] | null;
  textSearch: [string, string, unknown] | null;
  selectCount: number;
}

function buildClient(result: { data: unknown; error: unknown }) {
  const calls: Calls = {
    schema: null,
    from: null,
    insert: null,
    eq: [],
    order: null,
    textSearch: null,
    selectCount: 0,
  };
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => {
    calls.selectCount++;
    return q;
  });
  q.insert = vi.fn((row: Record<string, unknown>) => {
    calls.insert = row;
    return q;
  });
  q.eq = vi.fn((col: string, val: unknown) => {
    calls.eq.push([col, val]);
    return q;
  });
  q.order = vi.fn((col: string, opts: unknown) => {
    calls.order = [col, opts];
    return q;
  });
  q.textSearch = vi.fn((col: string, term: string, opts: unknown) => {
    calls.textSearch = [col, term, opts];
    return q;
  });
  q.single = vi.fn(() => Promise.resolve(result));
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  // thenable so `await query` (list/search) resolves to `result`
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);

  const from = vi.fn((t: string) => {
    calls.from = t;
    return q;
  });
  const schema = vi.fn((s: string) => {
    calls.schema = s;
    return { from };
  });
  return { client: { schema }, calls };
}

const row = {
  id: "t1",
  name: "Spring Promo",
  type: "text",
  category: "Promotion",
  tags: ["sale"],
  subject: null,
  body: "Big sale",
  storage_path: null,
  created_by: "amy@nsight.example",
  created_at: "2026-07-05T00:00:00Z",
  updated_at: "2026-07-05T00:00:00Z",
};

const validInput = {
  name: "Spring Promo",
  type: "text" as const,
  category: "Promotion",
  tags: ["Sale"],
  body: "Big sale",
};

describe("templates repo", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("createTemplate targets marketinghub.templates and stamps created_by=user.email", async () => {
    const { client, calls } = buildClient({ data: row, error: null });
    h.client = client;

    const result = await createTemplate(validInput, { email: "amy@nsight.example" });

    expect(calls.schema).toBe("marketinghub");
    expect(calls.from).toBe("templates");
    expect(calls.insert?.created_by).toBe("amy@nsight.example");
    expect(calls.insert?.name).toBe("Spring Promo");
    // tags normalized by the zod schema at the boundary
    expect(calls.insert?.tags).toEqual(["sale"]);
    expect(result.id).toBe("t1");
  });

  test("createTemplate throws (fail-loud) when PostgREST returns an error", async () => {
    const { client } = buildClient({ data: null, error: { message: "boom" } });
    h.client = client;
    await expect(
      createTemplate(validInput, { email: "amy@nsight.example" }),
    ).rejects.toThrow(/boom/);
  });

  test("listTemplates with no filters selects + orders and applies no eq filter", async () => {
    const { client, calls } = buildClient({ data: [row], error: null });
    h.client = client;

    const list = await listTemplates();

    expect(calls.selectCount).toBe(1);
    expect(calls.order?.[0]).toBe("created_at");
    expect(calls.eq).toEqual([]);
    expect(list).toHaveLength(1);
  });

  test("listTemplates filters by category and type", async () => {
    const { client, calls } = buildClient({ data: [], error: null });
    h.client = client;

    await listTemplates({ category: "Promotion", type: "email" });

    expect(calls.eq).toContainEqual(["category", "Promotion"]);
    expect(calls.eq).toContainEqual(["type", "email"]);
  });

  test("searchTemplates uses PostgREST websearch full-text on the search column", async () => {
    const { client, calls } = buildClient({ data: [row], error: null });
    h.client = client;

    await searchTemplates("spring sale");

    // config pinned to 'english' so the tsquery matches the english-generated
    // `search` tsvector regardless of the server default_text_search_config.
    expect(calls.textSearch).toEqual([
      "search",
      "spring sale",
      { type: "websearch", config: "english" },
    ]);
    // search results are ordered newest-first, matching the browse path.
    expect(calls.order?.[0]).toBe("created_at");
  });

  test("searchTemplates with a blank query falls back to a plain list (no textSearch)", async () => {
    const { client, calls } = buildClient({ data: [row], error: null });
    h.client = client;

    await searchTemplates("   ");

    expect(calls.textSearch).toBeNull();
    expect(calls.order?.[0]).toBe("created_at");
  });

  test("getTemplate returns the row when found", async () => {
    const { client, calls } = buildClient({ data: row, error: null });
    h.client = client;

    const found = await getTemplate("t1");

    expect(calls.eq).toContainEqual(["id", "t1"]);
    expect(found?.id).toBe("t1");
  });

  test("getTemplate returns null when not found", async () => {
    const { client } = buildClient({ data: null, error: null });
    h.client = client;
    const found = await getTemplate("missing");
    expect(found).toBeNull();
  });
});
