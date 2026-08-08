// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AnalyticsUnavailableError,
  LOG_SOURCES,
  apiErrorRates,
  apiRequestVolume,
  authEvents,
  listSources,
  queryLogs,
  serviceLogVolume,
  topRoutes,
  type MetricInterval,
} from "./logs";

const URL_BASE = "http://supabase.internal:8000";
const TOKEN = "private-logflare-token-for-tests";
const FROM = new Date("2026-08-08T00:00:00.000Z");
const TO = new Date("2026-08-08T06:00:00.000Z");

type FetchMock = ReturnType<typeof mockFetch>;

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

function mockResult(rows: unknown[] = []) {
  return mockFetch(200, { result: rows });
}

function sentUrl(fn: FetchMock, call = 0): URL {
  return new URL(String(fn.mock.calls[call][0]));
}

function sentSql(fn: FetchMock, call = 0): string {
  const sql = sentUrl(fn, call).searchParams.get("sql");
  expect(sql).toBeTruthy();
  return sql as string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EDGE_TEMPLATE_PREFIX =
  "select id, timestamp, event_message, metadata from edge_logs " +
  "cross join unnest(metadata) as m " +
  "cross join unnest(m.response) as response";

beforeEach(() => {
  process.env.SUPABASE_URL = URL_BASE;
  process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("source catalog", () => {
  test("listSources is the static 7-source allowlist, no network", () => {
    const fn = mockResult();
    const sources = listSources();
    expect(sources).toBe(LOG_SOURCES);
    expect(sources.map((s) => s.id)).toEqual([
      "edge_logs",
      "postgres_logs",
      "auth_logs",
      "postgrest_logs",
      "realtime_logs",
      "storage_logs",
      "function_edge_logs",
    ]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("severity derivations match the contract per source", () => {
    const byId = new Map(LOG_SOURCES.map((s) => [s.id, s]));
    expect(byId.get("edge_logs")?.severity?.expr).toContain(
      "response.status_code >= 500",
    );
    expect(byId.get("edge_logs")?.severity?.values).toEqual([
      "info",
      "warn",
      "error",
    ]);
    expect(byId.get("postgres_logs")?.severity?.expr).toBe(
      "parsed.error_severity",
    );
    expect(byId.get("postgres_logs")?.severity?.values).toEqual([
      "LOG",
      "NOTICE",
      "WARNING",
      "ERROR",
      "FATAL",
      "PANIC",
    ]);
    expect(byId.get("auth_logs")?.severity?.expr).toBe("m.level");
    expect(byId.get("realtime_logs")?.severity).toBeDefined();
    expect(byId.get("storage_logs")?.severity).toBeDefined();
    // No usable severity field → callers hide the filter.
    expect(byId.get("postgrest_logs")?.severity).toBeUndefined();
    expect(byId.get("function_edge_logs")?.severity).toBeUndefined();
  });
});

describe("transport", () => {
  test("sends the canonical logs.all request through Kong", async () => {
    const fn = mockResult();
    await queryLogs({ source: "edge_logs", from: FROM, to: TO });

    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(
      `${URL_BASE}/analytics/v1/api/endpoints/query/logs.all`,
    );
    expect(url.searchParams.get("project")).toBe("default");
    expect(url.searchParams.get("iso_timestamp_start")).toBe(
      FROM.toISOString(),
    );
    expect(url.searchParams.get("iso_timestamp_end")).toBe(TO.toISOString());
    const init = fn.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(TOKEN);
    expect(init?.cache).toBe("no-store");

    expect(sentSql(fn)).toBe(
      `${EDGE_TEMPLATE_PREFIX} order by timestamp desc limit 100`,
    );
  });

  test("from/to travel as iso params and NEVER appear in the SQL", async () => {
    const fn = mockResult();
    await queryLogs({ source: "auth_logs", from: FROM, to: TO });
    const sql = sentSql(fn);
    expect(sql).not.toContain("2026");
    expect(sql).not.toContain("iso_timestamp");
    expect(sentUrl(fn).searchParams.get("iso_timestamp_start")).toBe(
      FROM.toISOString(),
    );
  });

  test("missing token → AnalyticsUnavailableError before any fetch", async () => {
    delete process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN;
    const fn = mockResult();
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toMatch(
      /^\[console:logs\] analytics unreachable:/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test("missing SUPABASE_URL → AnalyticsUnavailableError", async () => {
    delete process.env.SUPABASE_URL;
    mockResult();
    await expect(
      queryLogs({ source: "edge_logs", from: FROM, to: TO }),
    ).rejects.toBeInstanceOf(AnalyticsUnavailableError);
  });

  test("network failure → AnalyticsUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toContain("ECONNREFUSED");
  });

  test("timeout (AbortError) → AnalyticsUnavailableError mentioning the timeout", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abort)),
    );
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toMatch(/timed out after 30000 ms/);
  });

  test("Kong 404 (route not enabled) → AnalyticsUnavailableError", async () => {
    mockFetch(404, { message: "no Route matched with those values" });
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toContain("not enabled");
  });

  test("Kong 401 (pre-route basic-auth catch-all / rejected token) → AnalyticsUnavailableError", async () => {
    // The pinned kong.yml ends with a basic-auth `dashboard` catch-all on
    // `/`, so BEFORE the analytics route is enabled this path 401s — the
    // designed pre-apply state on this stack, never a raw error banner.
    mockFetch(401, { message: "Unauthorized" });
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toContain("401");
  });

  test("Kong 502/503/504 (Logflare down/wedged/slow) → AnalyticsUnavailableError", async () => {
    for (const status of [502, 503, 504]) {
      mockFetch(status, "upstream unavailable");
      const err = await queryLogs({
        source: "edge_logs",
        from: FROM,
        to: TO,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AnalyticsUnavailableError);
      expect((err as Error).message).toContain(String(status));
      vi.unstubAllGlobals();
    }
  });

  test("a 200 with an error body is a plain [console:logs] failure, NOT unavailable", async () => {
    mockFetch(200, { error: { message: "query exceeded sandbox" } });
    const err = await queryLogs({
      source: "edge_logs",
      from: FROM,
      to: TO,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AnalyticsUnavailableError);
    expect((err as Error).message).toBe(
      "[console:logs] query-logs failed: query exceeded sandbox",
    );
  });

  test("string-shaped error bodies and non-OK statuses fail loud", async () => {
    mockFetch(200, { error: "bad token" });
    await expect(
      queryLogs({ source: "edge_logs", from: FROM, to: TO }),
    ).rejects.toThrow(/\[console:logs\] query-logs failed: bad token/);

    mockFetch(500, "internal error");
    await expect(
      queryLogs({ source: "edge_logs", from: FROM, to: TO }),
    ).rejects.toThrow(/\[console:logs\] query-logs failed: unparseable/);
  });

  test("a 200 without a result array fails loud", async () => {
    mockFetch(200, { rows: [] });
    await expect(
      queryLogs({ source: "edge_logs", from: FROM, to: TO }),
    ).rejects.toThrow(/unexpected response shape/);
  });
});

describe("queryLogs allowlists and injection resistance", () => {
  test("rejects unknown sources without fetching", async () => {
    const fn = mockResult();
    await expect(
      queryLogs({ source: "edge_logs; drop table x", from: FROM, to: TO }),
    ).rejects.toThrow(/\[console:logs\] query-logs failed: unknown source/);
    await expect(
      queryLogs({ source: "pg_shadow", from: FROM, to: TO }),
    ).rejects.toThrow(/unknown source/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("rejects severities on sources without a severity field", async () => {
    const fn = mockResult();
    await expect(
      queryLogs({
        source: "postgrest_logs",
        severities: ["error"],
        from: FROM,
        to: TO,
      }),
    ).rejects.toThrow(/does not support severity filtering/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("rejects severity values outside the source allowlist", async () => {
    const fn = mockResult();
    await expect(
      queryLogs({
        source: "edge_logs",
        severities: ["error') or ('1'='1"],
        from: FROM,
        to: TO,
      }),
    ).rejects.toThrow(/is not allowed for edge_logs/);
    await expect(
      queryLogs({
        source: "postgres_logs",
        severities: ["error"], // case-sensitive: postgres uses upper-case
        from: FROM,
        to: TO,
      }),
    ).rejects.toThrow(/is not allowed for postgres_logs/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("builds the severity IN-list only from allowlisted values", async () => {
    const fn = mockResult();
    await queryLogs({
      source: "edge_logs",
      severities: ["error", "warn"],
      from: FROM,
      to: TO,
    });
    expect(sentSql(fn)).toBe(
      `${EDGE_TEMPLATE_PREFIX} where ` +
        "case when response.status_code >= 500 then 'error' " +
        "when response.status_code >= 400 then 'warn' else 'info' end " +
        "in ('error', 'warn') order by timestamp desc limit 100",
    );
  });

  test("storage severity filter folds in the numeric pino encodings rows really carry", async () => {
    // At the pin storage-api's pino has no level formatter — rows carry
    // {"level": 40}, which the BQ→PG `->>` comparison sees as '40'. The
    // filter must match those (display already does, via PINO_LEVELS) or
    // the severity pills silently hide every real row.
    const fn = mockResult();
    await queryLogs({
      source: "storage_logs",
      severities: ["error", "warn"],
      from: FROM,
      to: TO,
    });
    expect(sentSql(fn)).toContain(
      "where m.level in ('error', '50', 'warn', '40')",
    );
  });

  test("hostile search strings never alter the query structure", async () => {
    const structural = new RegExp(
      "^" +
        escapeRegExp(EDGE_TEMPLATE_PREFIX) +
        " where event_message like '%(?:[^']|'')*%'" +
        " order by timestamp desc limit 100$",
    );
    const payloads = [
      "'; delete from edge_logs; --",
      "%' or '1'='1",
      "foo' union all select * from auth_logs --",
      "Robert'); DROP TABLE logs;--",
      "' ) order by 1; select pg_sleep(10); --",
    ];
    for (const payload of payloads) {
      const fn = mockResult();
      await queryLogs({
        source: "edge_logs",
        search: payload,
        from: FROM,
        to: TO,
      });
      const sql = sentSql(fn);
      // The whole statement still matches the fixed template: single quoted
      // LIKE literal (quotes only ever doubled), fixed order/limit tail.
      expect(sql).toMatch(structural);
      vi.unstubAllGlobals();
    }
  });

  test("quotes are doubled inside the LIKE literal", async () => {
    const fn = mockResult();
    await queryLogs({
      source: "edge_logs",
      search: "'; drop table logs; --",
      from: FROM,
      to: TO,
    });
    expect(sentSql(fn)).toBe(
      `${EDGE_TEMPLATE_PREFIX} where event_message like ` +
        "'%''; drop table logs; --%' order by timestamp desc limit 100",
    );
  });

  test("LIKE wildcards in search pass through AS wildcards (no backslash escapes)", async () => {
    // Deliberate: the pinned BQ→PG translator (sqlparser-rs BigQuery
    // dialect) consumes backslash escapes inside string literals, so an
    // emitted \% would reach Postgres as a bare % anyway — the lib emits
    // the wildcards untouched (deterministic, documented wildcard search)
    // and never emits backslashes at all.
    const fn = mockResult();
    await queryLogs({
      source: "edge_logs",
      search: "100%_done",
      from: FROM,
      to: TO,
    });
    const sql = sentSql(fn);
    expect(sql).toContain("like '%100%_done%'");
    expect(sql).not.toContain("\\");
  });

  test("backslashes and control characters in search are rejected", async () => {
    const fn = mockResult();
    await expect(
      queryLogs({
        source: "edge_logs",
        search: "a\\' or 1=1 --",
        from: FROM,
        to: TO,
      }),
    ).rejects.toThrow(/backslashes or control characters/);
    await expect(
      queryLogs({ source: "edge_logs", search: "a\nb", from: FROM, to: TO }),
    ).rejects.toThrow(/backslashes or control characters/);
    await expect(
      queryLogs({ source: "edge_logs", search: "a\u0000b", from: FROM, to: TO }),
    ).rejects.toThrow(/backslashes or control characters/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("search text is capped at 200 chars", async () => {
    const fn = mockResult();
    await queryLogs({
      source: "edge_logs",
      search: "a".repeat(250),
      from: FROM,
      to: TO,
    });
    const sql = sentSql(fn);
    expect(sql).toContain(`like '%${"a".repeat(200)}%'`);
    expect(sql).not.toContain("a".repeat(201));
  });

  test("invalid from/to are rejected without fetching", async () => {
    const fn = mockResult();
    await expect(
      queryLogs({ source: "edge_logs", from: "not-a-date", to: TO }),
    ).rejects.toThrow(/from is not a valid timestamp/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("clamps", () => {
  test("queryLogs limit clamps to [1, 1000] with default 100", async () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, 100],
      [5000, 1000],
      [0, 1],
      [-5, 1],
      [12.7, 12],
    ];
    for (const [given, expected] of cases) {
      const fn = mockResult();
      await queryLogs({
        source: "edge_logs",
        from: FROM,
        to: TO,
        limit: given,
      });
      expect(sentSql(fn)).toMatch(new RegExp(`limit ${expected}$`));
      vi.unstubAllGlobals();
    }
    mockResult();
    await expect(
      queryLogs({ source: "edge_logs", from: FROM, to: TO, limit: NaN }),
    ).rejects.toThrow(/limit must be a finite number/);
  });

  test("topRoutes limit clamps to [1, 100] with default 20", async () => {
    let fn = mockResult();
    await topRoutes({ from: FROM, to: TO });
    expect(sentSql(fn)).toMatch(/limit 20$/);
    vi.unstubAllGlobals();

    fn = mockResult();
    await topRoutes({ from: FROM, to: TO, limit: 500 });
    expect(sentSql(fn)).toMatch(/limit 100$/);
  });

  test("metric intervals are allowlisted", async () => {
    const fn = mockResult();
    await expect(
      apiRequestVolume({
        from: FROM,
        to: TO,
        interval: "hour; drop table logs" as MetricInterval,
      }),
    ).rejects.toThrow(/interval must be one of minute, hour, day/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("normalization", () => {
  test("normalizes BigQuery-shaped edge rows (µs epochs, repeated records)", async () => {
    mockResult([
      {
        id: "a",
        timestamp: 1786176000000000, // µs epoch
        event_message: "GET /rest/v1/contacts 502",
        metadata: [{ response: [{ status_code: 502 }] }],
      },
      {
        id: "b",
        timestamp: 1786176000000, // ms epoch
        event_message: "GET /rest/v1/contacts 404",
        metadata: [{ response: [{ status_code: 404 }] }],
      },
      {
        id: "c",
        timestamp: 1786176000, // s epoch
        event_message: "GET /rest/v1/contacts 200",
        metadata: [{ response: [{ status_code: 200 }] }],
      },
    ]);
    const rows = await queryLogs({ source: "edge_logs", from: FROM, to: TO });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      ts: "2026-08-08T08:00:00.000Z",
      level: "error",
      service: "api",
      event: "GET /rest/v1/contacts 502",
      metadata: [{ response: [{ status_code: 502 }] }],
    });
    expect(rows[1].ts).toBe("2026-08-08T08:00:00.000Z");
    expect(rows[1].level).toBe("warn");
    expect(rows[2].ts).toBe("2026-08-08T08:00:00.000Z");
    expect(rows[2].level).toBe("info");
  });

  test("normalizes Postgres-backend rows (plain objects, naive UTC strings)", async () => {
    mockResult([
      {
        id: "d",
        timestamp: "2026-08-08 12:34:56",
        event_message: "user signed in",
        metadata: { level: "INFO", msg: "user signed in" },
      },
    ]);
    const rows = await queryLogs({ source: "auth_logs", from: FROM, to: TO });
    expect(rows[0].ts).toBe("2026-08-08T12:34:56.000Z");
    expect(rows[0].level).toBe("info");
    expect(rows[0].service).toBe("auth");
  });

  test("derives levels per source contract", async () => {
    mockResult([
      {
        id: "e",
        timestamp: "2026-08-08T01:00:00.000Z",
        event_message: "terminating connection",
        metadata: [{ parsed: [{ error_severity: "FATAL" }] }],
      },
    ]);
    const pg = await queryLogs({
      source: "postgres_logs",
      from: FROM,
      to: TO,
    });
    expect(pg[0].level).toBe("fatal");
    expect(pg[0].service).toBe("database");
    vi.unstubAllGlobals();

    // Storage may emit numeric pino levels.
    mockResult([
      {
        id: "f",
        timestamp: "2026-08-08T01:00:00.000Z",
        event_message: "upload slow",
        metadata: { level: 40 },
      },
    ]);
    const storage = await queryLogs({
      source: "storage_logs",
      from: FROM,
      to: TO,
    });
    expect(storage[0].level).toBe("warn");
    vi.unstubAllGlobals();

    // Sources with no level field default to info; metadata passthrough.
    mockResult([
      {
        id: "g",
        timestamp: "2026-08-08T01:00:00.000Z",
        event_message: "08/Aug/2026 listening",
        metadata: null,
      },
    ]);
    const rest = await queryLogs({
      source: "postgrest_logs",
      from: FROM,
      to: TO,
    });
    expect(rest[0].level).toBe("info");
    expect(rest[0].service).toBe("postgrest");
    expect(rest[0].metadata).toBeNull();
  });
});

describe("canned report metrics", () => {
  test("apiRequestVolume: fixed edge_logs template split by request.path", async () => {
    const fn = mockResult([
      {
        bucket: 1786176000000000,
        total: "12",
        rest: 6,
        auth: "2",
        storage: 1,
        realtime: 0,
        functions: 3,
      },
    ]);
    const points = await apiRequestVolume({
      from: FROM,
      to: TO,
      interval: "hour",
    });
    const sql = sentSql(fn);
    expect(sql).toContain("timestamp_trunc(timestamp, hour) as bucket");
    expect(sql).toContain(
      "countif(regexp_contains(request.path, '^/rest')) as rest",
    );
    expect(sql).toContain(
      "countif(regexp_contains(request.path, '^/auth/v1')) as auth",
    );
    expect(sql).toContain(
      "from edge_logs cross join unnest(metadata) as m " +
        "cross join unnest(m.request) as request",
    );
    expect(sql).toContain("group by 1 order by 1 asc");
    expect(points).toEqual([
      {
        bucket: "2026-08-08T08:00:00.000Z",
        total: 12,
        rest: 6,
        auth: 2,
        storage: 1,
        realtime: 0,
        functions: 3,
      },
    ]);
  });

  test("apiErrorRates: countif >=400/>=500 vs total per bucket", async () => {
    const fn = mockResult([
      { bucket: "2026-08-08 03:00:00", total: 100, errors_4xx: 7, errors_5xx: 2 },
    ]);
    const points = await apiErrorRates({ from: FROM, to: TO, interval: "hour" });
    const sql = sentSql(fn);
    expect(sql).toContain("countif(response.status_code >= 400) as errors_4xx");
    expect(sql).toContain("countif(response.status_code >= 500) as errors_5xx");
    expect(points).toEqual([
      {
        bucket: "2026-08-08T03:00:00.000Z",
        total: 100,
        errors4xx: 7,
        errors5xx: 2,
      },
    ]);
  });

  test("topRoutes: method+path counts", async () => {
    const fn = mockResult([
      { method: "GET", path: "/rest/v1/contacts", hits: "42" },
    ]);
    const routes = await topRoutes({ from: FROM, to: TO, limit: 10 });
    const sql = sentSql(fn);
    expect(sql).toContain(
      "select request.method as method, request.path as path",
    );
    expect(sql).toContain("group by 1, 2 order by 3 desc limit 10");
    expect(routes).toEqual([
      { method: "GET", path: "/rest/v1/contacts", count: 42 },
    ]);
  });

  test("authEvents: auth_logs counts by level per bucket", async () => {
    const fn = mockResult([
      { bucket: "2026-08-08 04:00:00", level: "ERROR", hits: 3 },
    ]);
    const points = await authEvents({ from: FROM, to: TO, interval: "hour" });
    const sql = sentSql(fn);
    expect(sql).toContain("from auth_logs cross join unnest(metadata) as m");
    expect(sql).toContain("m.level as level");
    expect(points).toEqual([
      { bucket: "2026-08-08T04:00:00.000Z", level: "error", count: 3 },
    ]);
  });

  test("serviceLogVolume: one template instantiated for realtime + storage, merged", async () => {
    const fn = vi.fn((url: string | URL | Request) => {
      const sql = new URL(String(url)).searchParams.get("sql") ?? "";
      const rows = sql.includes("from realtime_logs")
        ? [{ bucket: "2026-08-08 05:00:00", level: "error", hits: 1 }]
        : [{ bucket: "2026-08-08 04:00:00", level: "info", hits: 9 }];
      return Promise.resolve(
        new Response(JSON.stringify({ result: rows }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fn);

    const points = await serviceLogVolume({
      from: FROM,
      to: TO,
      interval: "hour",
    });
    expect(fn).toHaveBeenCalledTimes(2);
    const sqls = fn.mock.calls.map(
      (call) => new URL(String(call[0])).searchParams.get("sql") ?? "",
    );
    expect(sqls.some((sql) => sql.includes("from realtime_logs"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("from storage_logs"))).toBe(true);
    // Merged and sorted by bucket, tagged with the service.
    expect(points).toEqual([
      {
        bucket: "2026-08-08T04:00:00.000Z",
        service: "storage",
        level: "info",
        count: 9,
      },
      {
        bucket: "2026-08-08T05:00:00.000Z",
        service: "realtime",
        level: "error",
        count: 1,
      },
    ]);
  });
});
