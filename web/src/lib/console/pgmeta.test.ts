// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  listColumns,
  listExtensions,
  listPolicies,
  listTables,
  runQuery,
} from "./pgmeta";

const URL_BASE = "http://supabase.internal:8000";
const KEY = "sr-key-for-tests";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    ),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pg-meta client", () => {
  test("fails loud when env is missing (never a silent no-op)", async () => {
    delete process.env.SUPABASE_URL;
    await expect(runQuery("select 1")).rejects.toThrow(
      /\[console:pgmeta\].*SUPABASE_URL/,
    );
  });

  test("listTables hits /pg/tables with schema filter and both auth headers", async () => {
    const fn = mockFetch(200, [{ id: 1, schema: "marketinghub", name: "t" }]);

    const tables = await listTables(["marketinghub", "public"]);

    expect(tables).toHaveLength(1);
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe(
      `${URL_BASE}/pg/tables?included_schemas=marketinghub%2Cpublic&include_columns=false`,
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  test("listColumns / listPolicies / listExtensions hit their endpoints", async () => {
    const fn = mockFetch(200, []);
    await listColumns(["marketinghub"]);
    await listPolicies(["marketinghub"]);
    await listExtensions();
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/pg/columns?included_schemas=marketinghub");
    expect(urls[1]).toContain("/pg/policies?included_schemas=marketinghub");
    expect(urls[2]).toContain("/pg/extensions");
  });

  test("runQuery POSTs the SQL and returns row objects", async () => {
    const fn = mockFetch(200, [{ ok: 1, current_user: "supabase_admin" }]);

    const rows = await runQuery("select 1 as ok, current_user");

    expect(rows).toEqual([{ ok: 1, current_user: "supabase_admin" }]);
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe(`${URL_BASE}/pg/query`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "select 1 as ok, current_user",
    });
  });

  test("surfaces the real Postgres error message from a pg-meta error body", async () => {
    mockFetch(400, {
      error: { message: 'relation "nope" does not exist' },
    });
    await expect(runQuery("select * from nope")).rejects.toThrow(
      /400: relation "nope" does not exist/,
    );
  });

  test("tolerates string-shaped and unparseable error bodies", async () => {
    mockFetch(500, { error: "connection refused" });
    await expect(runQuery("select 1")).rejects.toThrow(
      /500: connection refused/,
    );

    mockFetch(502, "<html>bad gateway</html>");
    await expect(runQuery("select 1")).rejects.toThrow(/502: <html>/);
  });

  test("a network failure is a loud [console:pgmeta] error, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    await expect(listTables(["marketinghub"])).rejects.toThrow(
      /\[console:pgmeta\] list-tables failed: ECONNREFUSED/,
    );
  });

  test("a 200 with an unparseable body still fails loud", async () => {
    mockFetch(200, "not json at all");
    await expect(runQuery("select 1")).rejects.toThrow(
      /unparseable response/,
    );
  });
});
