import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holders so each test can swap in a fresh mock client/provider.
const h = vi.hoisted(() => ({
  client: null as unknown,
  providerFromEnv: vi.fn(),
}));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

vi.mock("./providers", () => ({
  providerFromEnv: h.providerFromEnv,
}));

import {
  chunkStatus,
  createDocument,
  createSource,
  deleteSource,
  getSource,
  listDocumentsBySource,
  listSources,
  listSourceStats,
  NotProvisionedError,
  searchChunks,
  updateSource,
} from "./repo";

// ---------------------------------------------------------------------------
// Mock PostgREST client: each .from()/.rpc() consumes the next queued result;
// every builder call is recorded for assertions.
// ---------------------------------------------------------------------------

interface QueryCall {
  table: string | null;
  rpc: [string, unknown] | null;
  select: Array<[unknown?, unknown?]>;
  insert: unknown;
  update: unknown;
  delete: boolean;
  eq: Array<[string, unknown]>;
  order: [string, unknown] | null;
}

interface MockResult {
  data: unknown;
  error: unknown;
}

function buildClient(results: MockResult[]) {
  const calls = { schema: [] as string[], queries: [] as QueryCall[] };
  let idx = 0;

  function makeQuery(call: QueryCall) {
    const result = results[Math.min(idx++, results.length - 1)];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q: any = {};
    q.select = (...args: unknown[]) => {
      call.select.push(args as [unknown?, unknown?]);
      return q;
    };
    q.insert = (row: unknown) => {
      call.insert = row;
      return q;
    };
    q.update = (row: unknown) => {
      call.update = row;
      return q;
    };
    q.delete = () => {
      call.delete = true;
      return q;
    };
    q.eq = (col: string, val: unknown) => {
      call.eq.push([col, val]);
      return q;
    };
    q.order = (col: string, opts: unknown) => {
      call.order = [col, opts];
      return q;
    };
    q.single = () => Promise.resolve(result);
    q.maybeSingle = () => Promise.resolve(result);
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return q;
  }

  function newCall(): QueryCall {
    const call: QueryCall = {
      table: null,
      rpc: null,
      select: [],
      insert: null,
      update: null,
      delete: false,
      eq: [],
      order: null,
    };
    calls.queries.push(call);
    return call;
  }

  const client = {
    schema(name: string) {
      calls.schema.push(name);
      return {
        from(table: string) {
          const call = newCall();
          call.table = table;
          return makeQuery(call);
        },
        rpc(fn: string, params: unknown) {
          const call = newCall();
          call.rpc = [fn, params];
          return makeQuery(call);
        },
      };
    },
  };
  return { client, calls };
}

function installClient(results: MockResult[]) {
  const built = buildClient(results);
  h.client = built.client;
  return built;
}

const sourceRow = {
  id: "5f5e8c2a-9d1b-4f3a-8a51-51e6dd2e1a01",
  name: "Acme Corp",
  kind: "text",
  url: null,
  notes: null,
  created_by: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
};

const stubProvider = {
  dims: 1024,
  model: "stub-djb2-1024",
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0.25, 0.5])),
};

beforeEach(() => {
  h.client = null;
  h.providerFromEnv.mockReset();
  stubProvider.embed.mockClear();
  h.providerFromEnv.mockReturnValue(stubProvider);
});

describe("sources CRUD", () => {
  test("createSource targets competitor_intel.sources with the parsed input", async () => {
    const { calls } = installClient([{ data: sourceRow, error: null }]);

    const result = await createSource({
      name: "Acme Corp",
      kind: "text",
      url: null,
      notes: null,
    });

    expect(calls.schema).toEqual(["competitor_intel"]);
    expect(calls.queries[0].table).toBe("sources");
    expect(calls.queries[0].insert).toEqual({
      name: "Acme Corp",
      kind: "text",
      url: null,
      notes: null,
    });
    expect(result.id).toBe(sourceRow.id);
  });

  test("listSources orders by created_at desc and returns rows", async () => {
    const { calls } = installClient([{ data: [sourceRow], error: null }]);

    const rows = await listSources();

    expect(rows).toEqual([sourceRow]);
    expect(calls.queries[0].order).toEqual([
      "created_at",
      { ascending: false },
    ]);
  });

  test("updateSource patches ONLY provided keys and stamps updated_at", async () => {
    const { calls } = installClient([{ data: sourceRow, error: null }]);

    await updateSource(sourceRow.id, { notes: "renamed" });

    const patch = calls.queries[0].update as Record<string, unknown>;
    expect(patch.notes).toBe("renamed");
    expect(typeof patch.updated_at).toBe("string");
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("kind");
    expect(patch).not.toHaveProperty("url");
    expect(calls.queries[0].eq).toEqual([["id", sourceRow.id]]);
  });

  test("updateSource returns null when the id matches nothing", async () => {
    installClient([{ data: null, error: null }]);
    expect(await updateSource(sourceRow.id, { name: "X" })).toBeNull();
  });

  test("deleteSource true/false from returned rows", async () => {
    installClient([{ data: [{ id: sourceRow.id }], error: null }]);
    expect(await deleteSource(sourceRow.id)).toBe(true);

    installClient([{ data: [], error: null }]);
    expect(await deleteSource(sourceRow.id)).toBe(false);
  });

  test("fail-loud on ordinary PostgREST errors", async () => {
    installClient([{ data: null, error: { message: "boom", code: "XX000" } }]);
    await expect(getSource(sourceRow.id)).rejects.toThrow(
      "[intel] get-source failed: boom",
    );
  });

  test("listSourceStats aggregates doc/chunk/embedded counts per source", async () => {
    installClient([
      {
        data: [
          { id: "d1", source_id: "s1", status: "embedded", chunks: [{ count: 3 }] },
          { id: "d2", source_id: "s1", status: "pending", chunks: [{ count: 0 }] },
          { id: "d3", source_id: "s2", status: "error", chunks: [{ count: 5 }] },
        ],
        error: null,
      },
    ]);

    const stats = await listSourceStats();
    expect(stats).toEqual([
      {
        source_id: "s1",
        document_count: 2,
        chunk_count: 3,
        embedded_document_count: 1,
      },
      {
        source_id: "s2",
        document_count: 1,
        chunk_count: 5,
        embedded_document_count: 0,
      },
    ]);
  });
});

describe("not-provisioned mapping", () => {
  test.each([
    ["PGRST106", "The schema must be one of the following: marketinghub"],
    ["PGRST205", "Could not find the table 'competitor_intel.sources'"],
    ["42P01", 'relation "competitor_intel.sources" does not exist'],
    ["3F000", 'schema "competitor_intel" does not exist'],
  ])("PostgREST %s becomes NotProvisionedError", async (code, message) => {
    installClient([{ data: null, error: { code, message } }]);
    await expect(listSources()).rejects.toBeInstanceOf(NotProvisionedError);
  });

  test("match_chunks missing (PGRST202) becomes NotProvisionedError", async () => {
    installClient([
      {
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function competitor_intel.match_chunks",
        },
      },
    ]);
    await expect(searchChunks("pricing")).rejects.toBeInstanceOf(
      NotProvisionedError,
    );
  });
});

describe("documents", () => {
  const docRow = {
    id: "9a1b2c3d-0000-4111-8222-333344445555",
    source_id: sourceRow.id,
    title: "Pricing page",
    content: "## Pricing\nAcme charges $99.",
    status: "pending",
    error: null,
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  };

  test("createDocument inserts source_id/title/content and NOTHING else (status is a DB default)", async () => {
    const { calls } = installClient([{ data: docRow, error: null }]);

    const result = await createDocument({
      sourceId: sourceRow.id,
      title: "Pricing page",
      content: "## Pricing\nAcme charges $99.",
    });

    expect(calls.queries[0].table).toBe("documents");
    expect(calls.queries[0].insert).toEqual({
      source_id: sourceRow.id,
      title: "Pricing page",
      content: "## Pricing\nAcme charges $99.",
    });
    expect(result.status).toBe("pending");
  });

  test("listDocumentsBySource never fetches content bodies and maps chunk counts", async () => {
    const { calls } = installClient([
      {
        data: [
          {
            id: docRow.id,
            source_id: docRow.source_id,
            title: docRow.title,
            status: "embedded",
            error: null,
            created_at: docRow.created_at,
            updated_at: docRow.updated_at,
            chunks: [{ count: 4 }],
          },
        ],
        error: null,
      },
    ]);

    const rows = await listDocumentsBySource(sourceRow.id);

    const selectArg = String(calls.queries[0].select[0]?.[0]);
    expect(selectArg).toContain("chunks(count)");
    expect(selectArg).not.toMatch(/\bcontent\b/);
    expect(rows[0].chunk_count).toBe(4);
    expect(rows[0]).not.toHaveProperty("chunks");
    expect(rows[0]).not.toHaveProperty("content");
  });
});

describe("chunkStatus", () => {
  test("null when the document does not exist", async () => {
    installClient([{ data: null, error: null }]);
    expect(await chunkStatus("missing-id")).toBeNull();
  });

  test("aggregates chunk/embedded counts, models and last embed time", async () => {
    installClient([
      { data: { id: "d1", status: "processing", error: null }, error: null },
      {
        data: [
          { embedding_model: "stub-djb2-1024", embedded_at: "2026-08-08T01:00:00Z" },
          { embedding_model: "stub-djb2-1024", embedded_at: "2026-08-08T02:00:00Z" },
          { embedding_model: null, embedded_at: null },
        ],
        error: null,
      },
    ]);

    const status = await chunkStatus("d1");
    expect(status).toEqual({
      document_id: "d1",
      status: "processing",
      error: null,
      chunk_count: 3,
      embedded_count: 2,
      embedding_models: ["stub-djb2-1024"],
      last_embedded_at: "2026-08-08T02:00:00Z",
    });
  });
});

describe("searchChunks", () => {
  const matchRow = {
    chunk_id: 7,
    document_id: "d1",
    source_id: "s1",
    seq: 0,
    content: "Acme charges $99.",
    similarity: 0.87,
    embedding_model: "stub-djb2-1024",
    document_title: "Pricing page",
    source_name: "Acme Corp",
  };

  test("embeds the query via the env provider then calls match_chunks with bound params", async () => {
    const { calls } = installClient([{ data: [matchRow], error: null }]);

    const result = await searchChunks("acme pricing", {
      sourceId: sourceRow.id,
      count: 5,
    });

    expect(stubProvider.embed).toHaveBeenCalledWith(["acme pricing"]);
    expect(calls.schema).toEqual(["competitor_intel"]);
    expect(calls.queries[0].rpc).toEqual([
      "match_chunks",
      {
        query_embedding: [0.25, 0.5],
        match_count: 5,
        filter_source_id: sourceRow.id,
      },
    ]);
    expect(result.rows).toEqual([matchRow]);
    expect(result.provider).toEqual({ model: "stub-djb2-1024", dims: 1024 });
    expect(result.mismatchedModels).toEqual([]);
  });

  test("defaults: count 8, no source filter", async () => {
    const { calls } = installClient([{ data: [], error: null }]);

    await searchChunks("q");

    expect(calls.queries[0].rpc?.[1]).toEqual({
      query_embedding: [0.25, 0.5],
      match_count: 8,
      filter_source_id: null,
    });
  });

  test("clamps count into 1..50", async () => {
    let built = installClient([{ data: [], error: null }]);
    await searchChunks("q", { count: 999 });
    expect(
      (built.calls.queries[0].rpc?.[1] as { match_count: number }).match_count,
    ).toBe(50);

    built = installClient([{ data: [], error: null }]);
    await searchChunks("q", { count: 0 });
    expect(
      (built.calls.queries[0].rpc?.[1] as { match_count: number }).match_count,
    ).toBe(1);
  });

  test("flags corpus models that differ from the query provider", async () => {
    installClient([
      {
        data: [
          matchRow,
          { ...matchRow, chunk_id: 8, embedding_model: "amazon.titan-embed-text-v2:0" },
          { ...matchRow, chunk_id: 9, embedding_model: null },
        ],
        error: null,
      },
    ]);

    const result = await searchChunks("q");
    expect(result.mismatchedModels).toEqual(["amazon.titan-embed-text-v2:0"]);
  });

  test("uses the threaded user client instead of the service client", async () => {
    const { client, calls } = buildClient([{ data: [], error: null }]);
    h.client = {
      schema() {
        throw new Error("service client must not be used when db is threaded");
      },
    };

    await searchChunks("q", {}, client as never);
    expect(calls.queries[0].rpc?.[0]).toBe("match_chunks");
  });
});
