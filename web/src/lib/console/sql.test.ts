// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as unknown,
  runQuery: vi.fn(),
}));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));
vi.mock("./pgmeta", () => ({
  runQuery: h.runQuery,
}));

import {
  classifySql,
  createSnippet,
  deleteSnippet,
  listHistory,
  listSnippets,
  ReadOnlyViolationError,
  runConsoleQuery,
  updateSnippet,
  MAX_RESULT_ROWS,
} from "./sql";

/** Minimal chainable-thenable PostgREST mock (subset of the sms repo one). */
type MockResult = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): MockResult => ({ data, error: null });

function buildClient(results: MockResult[] = []) {
  const logs: Array<{ table: string; insert?: unknown; update?: unknown; delete?: boolean }> = [];
  let next = 0;
  const from = vi.fn((table: string) => {
    const log: { table: string; insert?: unknown; update?: unknown; delete?: boolean } = { table };
    logs.push(log);
    const result = results[next++] ?? { data: null, error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "limit", "eq"]) {
      q[m] = vi.fn(() => q);
    }
    q.insert = vi.fn((row: unknown) => ((log.insert = row), q));
    q.update = vi.fn((row: unknown) => ((log.update = row), q));
    q.delete = vi.fn(() => ((log.delete = true), q));
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return q;
  });
  const schema = vi.fn(() => ({ from }));
  return { client: { schema }, logs };
}

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("classifySql", () => {
  test("read-only statements classify as read", () => {
    expect(classifySql("select 1")).toBe("read");
    expect(classifySql("  SELECT * FROM marketinghub.templates;")).toBe("read");
    expect(classifySql("explain analyze select 1")).toBe("read");
    expect(classifySql("show search_path")).toBe("read");
    expect(classifySql("-- comment\nselect 1; select 2;")).toBe("read");
    expect(classifySql("with t as (select 1) select * from t")).toBe("read");
  });

  test("writes, DDL, and anything unprovable classify as write", () => {
    expect(classifySql("update marketinghub.templates set name = 'x'")).toBe("write");
    expect(classifySql("delete from marketinghub.sms_suppressions")).toBe("write");
    expect(classifySql("insert into t values (1)")).toBe("write");
    expect(classifySql("drop table marketinghub.templates")).toBe("write");
    expect(classifySql("create index on t (a)")).toBe("write");
    expect(classifySql("truncate t")).toBe("write");
    expect(classifySql("grant all on t to public")).toBe("write");
    // data-modifying CTE inside a WITH
    expect(
      classifySql("with x as (delete from t returning *) select * from x"),
    ).toBe("write");
    // mixed batch: one write poisons the batch
    expect(classifySql("select 1; update t set a = 1;")).toBe("write");
    // empty / un-tokenizable → conservative
    expect(classifySql("   ")).toBe("write");
    expect(classifySql("/* only a comment */")).toBe("write");
  });
});

describe("runConsoleQuery", () => {
  test("reads run inside a read-only transaction wrapper", async () => {
    h.runQuery.mockResolvedValue([{ ok: 1 }]);
    h.client = buildClient([ok(null)]).client;

    await runConsoleQuery("select 1", "amy@nsight.example");

    expect(h.runQuery).toHaveBeenCalledWith(
      "begin transaction read only; select 1; commit;",
    );
  });

  test("a confirmed write runs raw (no read-only wrapper)", async () => {
    h.runQuery.mockResolvedValue([]);
    h.client = buildClient([ok(null)]).client;

    await runConsoleQuery(
      "update marketinghub.templates set name='x'",
      "amy@nsight.example",
      true,
    );

    expect(h.runQuery).toHaveBeenCalledWith(
      "update marketinghub.templates set name='x'",
    );
  });

  test("a read that actually writes (25006) throws ReadOnlyViolationError, records nothing", async () => {
    h.runQuery.mockRejectedValue(
      new Error(
        "[console:pgmeta] query failed: 400: cannot execute UPDATE in a read-only transaction",
      ),
    );
    const { client, logs } = buildClient([ok(null)]);
    h.client = client;

    await expect(
      // EXPLAIN ANALYZE UPDATE classifies read but executes a write
      runConsoleQuery(
        "explain analyze update marketinghub.templates set name='x'",
        "amy@nsight.example",
      ),
    ).rejects.toBeInstanceOf(ReadOnlyViolationError);

    // aborted txn: no history row written
    expect(logs.find((l) => l.table === "console_query_history")).toBeUndefined();
  });

  test("runs, caps rows at MAX_RESULT_ROWS, and records history", async () => {
    const big = Array.from({ length: MAX_RESULT_ROWS + 5 }, (_, i) => ({ i }));
    h.runQuery.mockResolvedValue(big);
    const { client, logs } = buildClient([ok(null)]);
    h.client = client;

    const result = await runConsoleQuery("select 1", "amy@nsight.example");

    expect(result.rows).toHaveLength(MAX_RESULT_ROWS);
    expect(result.rowCount).toBe(MAX_RESULT_ROWS + 5);
    expect(result.truncated).toBe(true);
    expect(result.classification).toBe("read");
    const hist = logs.find((l) => l.table === "console_query_history");
    expect(hist?.insert).toMatchObject({
      sql: "select 1",
      ran_by: "amy@nsight.example",
      row_count: MAX_RESULT_ROWS + 5,
      error: null,
    });
  });

  test("a Postgres error still writes a history row, then rethrows", async () => {
    h.runQuery.mockRejectedValue(
      new Error('[console:pgmeta] query failed: 400: relation "nope" does not exist'),
    );
    const { client, logs } = buildClient([ok(null)]);
    h.client = client;

    await expect(
      runConsoleQuery("select * from nope", "amy@nsight.example"),
    ).rejects.toThrow(/does not exist/);

    const hist = logs.find((l) => l.table === "console_query_history");
    expect(hist?.insert).toMatchObject({
      sql: "select * from nope",
      row_count: null,
    });
    expect((hist?.insert as { error: string }).error).toContain("does not exist");
  });

  test("a failed history insert never fails the query (best-effort, logged)", async () => {
    h.runQuery.mockResolvedValue([{ ok: 1 }]);
    h.client = buildClient([
      { data: null, error: { message: "history table missing" } },
    ]).client;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runConsoleQuery("select 1", "amy@x");
    expect(result.rowCount).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("snippets + history persistence", () => {
  test("CRUD round-trips through PostgREST", async () => {
    const snippet = { id: "s1", name: "top tables", sql: "select 1" };
    const { client, logs } = buildClient([
      ok([snippet]), // list
      ok(snippet), // create
      ok({ ...snippet, name: "renamed" }), // update
      ok({ id: "s1" }), // delete
      ok([]), // history
    ]);
    h.client = client;

    expect(await listSnippets()).toEqual([snippet]);
    expect(await createSnippet("top tables", "select 1", "amy@x")).toEqual(snippet);
    expect(logs[1].insert).toEqual({
      name: "top tables",
      sql: "select 1",
      created_by: "amy@x",
    });
    expect((await updateSnippet("s1", { name: "renamed" }))?.name).toBe("renamed");
    expect(await deleteSnippet("s1")).toBe(true);
    expect(await listHistory()).toEqual([]);
  });
});
