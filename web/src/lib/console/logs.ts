import "server-only";

/**
 * Server-only Logflare analytics client — Wave 6 observability foundation.
 *
 * Everything here goes through Kong's `analytics-v1-api` route:
 *
 *   GET <SUPABASE_URL>/analytics/v1/api/endpoints/query/logs.all
 *       ?project=default
 *       &iso_timestamp_start=<ISO>&iso_timestamp_end=<ISO>
 *       &sql=<url-encoded BigQuery-SQL over the logs.all sandbox CTEs>
 *   header: x-api-key: <LOGFLARE_PRIVATE_ACCESS_TOKEN>
 *
 * Load-bearing invariants:
 *
 *   1. READ-ONLY by design. The SQL sent upstream is built ONLY from the
 *      fixed per-source templates below. User input is never structural:
 *      sources/severities/intervals are allowlisted, limits are clamped,
 *      timestamps travel as iso_timestamp_start/end query params (never
 *      spliced into SQL), and search text is bound as a quote-escaped LIKE
 *      literal (`%`/`_` stay live LIKE wildcards — deliberate, see
 *      escapeSearchLiteral). Raw user SQL never reaches Logflare from this
 *      module.
 *   2. Callers must already sit behind the console auth gate
 *      (requireMarketingUser on pages, requireUser on routes) — logs can
 *      carry PHI-adjacent request data.
 *   3. Honest degradation: until the operator applies the staged W6 steps
 *      (Kong route enable + task-def token), LOGFLARE_PRIVATE_ACCESS_TOKEN
 *      is absent from the app env — that state, plus network failures,
 *      timeouts, and the gateway statuses that mean "analytics is not
 *      answering" (401 pre-route via Kong's basic-auth dashboard catch-all,
 *      404 route-not-enabled, 502/503/504 Logflare down/wedged/slow), throws
 *      AnalyticsUnavailableError so pages can render the "Analytics
 *      unavailable" Surface. Everything else throws plain
 *      `[console:logs] <op> failed: <msg>` errors, which consoleAttempt
 *      maps to 400s.
 *   4. Logflare returns errors as HTTP 200 with an `error` key in the
 *      body — the body is ALWAYS inspected, never just the status.
 */

/** Kong upstream timeout is 60s; stay under it so errors are ours, not 504s. */
const LOGS_TIMEOUT_MS = 30_000;

/**
 * Analytics cannot be reached at all (token not yet staged, Kong route not
 * yet enabled, network failure, timeout). Pages catch THIS class to render
 * the honest "Analytics unavailable" state; anything else is a real error.
 */
export class AnalyticsUnavailableError extends Error {
  constructor(detail: string) {
    super(`[console:logs] analytics unreachable: ${detail}`);
    this.name = "AnalyticsUnavailableError";
  }
}

function fail(op: string, message: string): never {
  throw new Error(`[console:logs] ${op} failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Sources — static allowlist, no network. These are exactly the logs.all
// sandbox CTEs that carry real data self-hosted (function_logs and
// pgbouncer_logs receive nothing from vector and are deliberately absent).
// ---------------------------------------------------------------------------

export type LogSourceId =
  | "edge_logs"
  | "postgres_logs"
  | "auth_logs"
  | "postgrest_logs"
  | "realtime_logs"
  | "storage_logs"
  | "function_edge_logs";

export interface LogSourceSeverity {
  /**
   * SQL expression (valid over the source's fixed FROM/unnest chain) that
   * yields the severity value the IN-list filters on.
   */
  expr: string;
  /** Exhaustive allowlist of severity values queryLogs accepts. */
  values: readonly string[];
  /**
   * Extra SQL literals folded into the IN-list per allowlisted value —
   * OUR constants, never user input. Storage needs this: at the pin
   * (storage-api v1.48.26) pino has NO level formatter, so its rows carry
   * NUMERIC levels ({"level":40}) that the BQ→PG `->>` text comparison
   * renders as '40' — a name-only IN-list would never match a real row.
   * The names stay in the list as belt-and-braces for future pins.
   */
  aliases?: Readonly<Record<string, readonly string[]>>;
}

export interface LogSource {
  id: LogSourceId;
  label: string;
  /** Absent when the source has no usable severity field — hide the filter. */
  severity?: LogSourceSeverity;
}

const EDGE_SEVERITY_EXPR =
  "case when response.status_code >= 500 then 'error' " +
  "when response.status_code >= 400 then 'warn' else 'info' end";

export const LOG_SOURCES: readonly LogSource[] = [
  {
    id: "edge_logs",
    label: "API / Edge (Kong)",
    severity: { expr: EDGE_SEVERITY_EXPR, values: ["info", "warn", "error"] },
  },
  {
    id: "postgres_logs",
    label: "Postgres",
    severity: {
      expr: "parsed.error_severity",
      values: ["LOG", "NOTICE", "WARNING", "ERROR", "FATAL", "PANIC"],
    },
  },
  {
    id: "auth_logs",
    label: "Auth (GoTrue)",
    severity: {
      expr: "m.level",
      values: ["trace", "debug", "info", "warning", "error", "fatal", "panic"],
    },
  },
  { id: "postgrest_logs", label: "PostgREST" },
  {
    id: "realtime_logs",
    label: "Realtime",
    severity: {
      expr: "m.level",
      values: ["debug", "info", "notice", "warning", "error"],
    },
  },
  {
    id: "storage_logs",
    label: "Storage",
    severity: {
      expr: "m.level",
      values: ["trace", "debug", "info", "warn", "error", "fatal"],
      // Pino numeric encodings — what storage rows ACTUALLY carry at the
      // pin (mirrors PINO_LEVELS, which deriveLevel already uses to render
      // these same numbers as names). Filter and display must agree.
      aliases: {
        trace: ["10"],
        debug: ["20"],
        info: ["30"],
        warn: ["40"],
        error: ["50"],
        fatal: ["60"],
      },
    },
  },
  { id: "function_edge_logs", label: "Edge Functions" },
];

/** Static source list for pickers — never touches the network. */
export function listSources(): readonly LogSource[] {
  return LOG_SOURCES;
}

/**
 * Fixed per-source FROM clauses (source CTE + only the unnests its severity
 * expression needs) and the normalized service name for each source.
 */
const SOURCE_INTERNALS: Record<
  LogSourceId,
  { fromClause: string; service: string }
> = {
  edge_logs: {
    fromClause:
      "edge_logs cross join unnest(metadata) as m " +
      "cross join unnest(m.response) as response",
    service: "api",
  },
  postgres_logs: {
    fromClause:
      "postgres_logs cross join unnest(metadata) as m " +
      "cross join unnest(m.parsed) as parsed",
    service: "database",
  },
  auth_logs: {
    fromClause: "auth_logs cross join unnest(metadata) as m",
    service: "auth",
  },
  postgrest_logs: { fromClause: "postgrest_logs", service: "postgrest" },
  realtime_logs: {
    fromClause: "realtime_logs cross join unnest(metadata) as m",
    service: "realtime",
  },
  storage_logs: {
    fromClause: "storage_logs cross join unnest(metadata) as m",
    service: "storage",
  },
  function_edge_logs: {
    fromClause: "function_edge_logs",
    service: "functions",
  },
};

// ---------------------------------------------------------------------------
// Input binding — user text is never structural.
// ---------------------------------------------------------------------------

/** Cap on search text; anything longer is truncated before escaping. */
const SEARCH_MAX_CHARS = 200;

/**
 * Bind free-text search as a LIKE literal. Backslashes and control
 * characters are rejected outright (never sanitized-and-forwarded) and
 * single quotes are doubled. LIKE wildcards %/_ deliberately pass through
 * AS wildcards: Logflare at the pin (1.36.1) re-parses this SQL with
 * sqlparser-rs's BigQuery dialect, whose tokenizer CONSUMES backslash
 * escape sequences inside string literals (an emitted `\%` reaches
 * Postgres as a bare `%`), so backslash-escaping cannot survive the
 * BQ→PG round-trip — passing the wildcards through untouched is the only
 * behavior that is deterministic at the pin. No injection surface either
 * way: the value stays a quoted literal (quote-doubling DOES survive the
 * round-trip) and is only ever placed INSIDE `like '%...%'` in the fixed
 * templates.
 */
function escapeSearchLiteral(op: string, raw: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) {
    fail(op, "search may not contain backslashes or control characters");
  }
  return raw.slice(0, SEARCH_MAX_CHARS).replace(/'/g, "''");
}

/** Clamp an optional integer limit into [1, max]; undefined → fallback. */
function clampLimit(
  op: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(op, "limit must be a finite number");
  }
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/**
 * Normalize a from/to bound to a strict ISO-8601 string. The result is sent
 * as an iso_timestamp_start/end query param — NEVER spliced into SQL — and
 * re-serializing through Date guarantees the param is a pure timestamp.
 */
function isoParam(op: string, name: "from" | "to", value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail(op, `${name} is not a valid timestamp`);
  }
  return date.toISOString();
}

export type MetricInterval = "minute" | "hour" | "day";

const METRIC_INTERVALS: readonly MetricInterval[] = ["minute", "hour", "day"];

export interface MetricRange {
  from: Date | string;
  to: Date | string;
  interval: MetricInterval;
}

function metricArgs(
  op: string,
  range: MetricRange,
): { fromIso: string; toIso: string; interval: MetricInterval } {
  if (!METRIC_INTERVALS.includes(range.interval)) {
    fail(op, `interval must be one of ${METRIC_INTERVALS.join(", ")}`);
  }
  return {
    fromIso: isoParam(op, "from", range.from),
    toIso: isoParam(op, "to", range.to),
    interval: range.interval,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Best-effort message from a Logflare `error` body value (shapes vary). */
function extractError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      // fall through
    }
  }
  return String(error);
}

/**
 * Statuses that mean "analytics is not answering", not "your query failed".
 * The pinned kong.yml ends with a basic-auth `dashboard` catch-all on `/`,
 * so BEFORE the analytics-v1-api route is enabled Kong answers 401 (never
 * 404) for this path; 404 covers a kong.yml without the catch-all; 502/503/
 * 504 are Kong telling us the route exists but Logflare is down/wedged/slow.
 * Logflare's own auth rejection is also a 401 — a stale/rotated token is
 * equally "unreachable" for the console (honest state, operator action).
 */
const UNAVAILABLE_STATUS: Record<number, string> = {
  401: "401 — analytics route not enabled (pre-apply requests hit the " +
    "basic-auth dashboard catch-all) or the analytics token was rejected",
  404: "404 — the analytics-v1-api route is not enabled " +
    "(staged W6 route apply pending)",
  502: "502 — Kong could not reach the analytics container",
  503: "503 — the analytics service is unavailable behind Kong",
  504: "504 — the analytics service timed out behind Kong",
};

/**
 * One logs.all endpoint query. Unreachable states (missing env, network,
 * timeout, and the UNAVAILABLE_STATUS gateway answers above) throw
 * AnalyticsUnavailableError; everything else — including Logflare's
 * 200-with-{"error"} bodies — throws plain [console:logs] errors.
 */
async function runEndpointQuery(
  op: string,
  sql: string,
  fromIso: string,
  toIso: string,
): Promise<Array<Record<string, unknown>>> {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new AnalyticsUnavailableError(
      "SUPABASE_URL is not configured on this server",
    );
  }
  const token = process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN;
  if (!token) {
    throw new AnalyticsUnavailableError(
      "LOGFLARE_PRIVATE_ACCESS_TOKEN is not configured on this server " +
        "(staged W6 env apply pending)",
    );
  }

  const url = new URL(`${base}/analytics/v1/api/endpoints/query/logs.all`);
  url.searchParams.set("project", "default");
  url.searchParams.set("iso_timestamp_start", fromIso);
  url.searchParams.set("iso_timestamp_end", toIso);
  url.searchParams.set("sql", sql);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": token, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    const detail =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${LOGS_TIMEOUT_MS} ms`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new AnalyticsUnavailableError(detail);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (UNAVAILABLE_STATUS[res.status]) {
    // Kong answers these while the route is not enabled (401/404 — the
    // designed pre-apply state) or while Logflare is degraded (502/503/504)
    // — unreachable states, never query errors.
    throw new AnalyticsUnavailableError(
      `Kong returned ${UNAVAILABLE_STATUS[res.status]}`,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(op, `unparseable response: ${text.slice(0, 200)}`);
  }

  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  // Logflare reports endpoint errors as 200 + {"error": ...} — check the
  // body FIRST, never trust the status alone.
  if (record && record.error != null) {
    fail(op, extractError(record.error));
  }
  if (!res.ok) {
    fail(op, `${res.status}: ${text.slice(0, 500)}`);
  }
  if (!record || !Array.isArray(record.result)) {
    fail(op, "unexpected response shape: missing result array");
  }
  return record.result as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Normalized lowercase level ("info" when the source has none). */
  level: string;
  /** Normalized service name (api, database, auth, postgrest, realtime, storage, functions). */
  service: string;
  /** The log line (event_message). */
  event: string;
  /** Raw Logflare metadata, untouched (object or BigQuery-style array). */
  metadata: unknown;
}

/**
 * Unwrap one step of Logflare metadata: BigQuery-shaped rows carry repeated
 * records (arrays of one object); the Postgres backend stores plain objects.
 */
function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const inner = Array.isArray(value) ? value[0] : value;
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : undefined;
}

/** Walk a metadata path, unwrapping single-element arrays at each hop. */
function pluck(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = firstRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return Array.isArray(current) ? current[0] : current;
}

/** Pino numeric levels (storage may emit these). */
const PINO_LEVELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function levelLabel(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value.toLowerCase();
  }
  if (typeof value === "number" && PINO_LEVELS[value]) {
    return PINO_LEVELS[value];
  }
  return "info";
}

function deriveLevel(id: LogSourceId, metadata: unknown): string {
  switch (id) {
    case "edge_logs": {
      const status = Number(pluck(metadata, ["response", "status_code"]));
      if (Number.isFinite(status) && status > 0) {
        return status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      }
      return "info";
    }
    case "postgres_logs": {
      const severity = pluck(metadata, ["parsed", "error_severity"]);
      return typeof severity === "string" && severity !== ""
        ? severity.toLowerCase()
        : "info";
    }
    case "auth_logs":
    case "realtime_logs":
    case "storage_logs":
      return levelLabel(pluck(metadata, ["level"]));
    default:
      // postgrest_logs / function_edge_logs carry no level field.
      return "info";
  }
}

/**
 * Normalize a Logflare timestamp (µs/ms/s epoch number, numeric string, or
 * ISO-ish string — the Postgres backend emits naive UTC strings) to ISO-8601.
 */
function tsToIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms =
      value >= 1e14 ? value / 1000 : value >= 1e11 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value !== "") {
    if (/^\d+$/.test(value)) return tsToIso(Number(value));
    const naiveUtc = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(
      value,
    );
    const date = new Date(naiveUtc ? `${value.replace(" ", "T")}Z` : value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return "";
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return value == null ? "" : String(value);
}

// ---------------------------------------------------------------------------
// Log explorer query
// ---------------------------------------------------------------------------

export interface QueryLogsParams {
  /** Must be a LOG_SOURCES id — anything else throws. */
  source: string;
  /** Free text, bound as an escaped LIKE literal (max 200 chars). */
  search?: string;
  /** Values must be in the source's severity allowlist. */
  severities?: string[];
  from: Date | string;
  to: Date | string;
  /** Clamped to [1, 1000]; default 100. */
  limit?: number;
}

/**
 * Query one source through the logs.all sandbox. The SQL is a fixed
 * per-source template; the only variance is the allowlisted severity
 * IN-list, the escaped LIKE literal, and the clamped limit.
 */
export async function queryLogs(params: QueryLogsParams): Promise<LogEntry[]> {
  const op = "query-logs";
  const source = LOG_SOURCES.find((entry) => entry.id === params.source);
  if (!source) {
    fail(
      op,
      `unknown source "${String(params.source).slice(0, 60)}" — ` +
        `must be one of ${LOG_SOURCES.map((entry) => entry.id).join(", ")}`,
    );
  }
  const internals = SOURCE_INTERNALS[source.id];
  const limit = clampLimit(op, params.limit, 100, 1000);
  const fromIso = isoParam(op, "from", params.from);
  const toIso = isoParam(op, "to", params.to);

  const where: string[] = [];
  if (params.severities !== undefined && params.severities.length > 0) {
    const severity = source.severity;
    if (!severity) {
      fail(op, `source "${source.id}" does not support severity filtering`);
    }
    const picked = [...new Set(params.severities)];
    for (const value of picked) {
      if (!severity.values.includes(value)) {
        fail(
          op,
          `severity "${String(value).slice(0, 40)}" is not allowed for ` +
            source.id,
        );
      }
    }
    // Fold in the per-value alias literals (our constants — e.g. storage's
    // numeric pino encodings) so the filter matches what rows really carry.
    const literals = picked.flatMap((value) => [
      value,
      ...(severity.aliases?.[value] ?? []),
    ]);
    where.push(
      `${severity.expr} in (${literals.map((value) => `'${value}'`).join(", ")})`,
    );
  }
  if (params.search !== undefined && params.search !== "") {
    where.push(
      `event_message like '%${escapeSearchLiteral(op, params.search)}%'`,
    );
  }

  const sql =
    `select id, timestamp, event_message, metadata from ${internals.fromClause}` +
    (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
    ` order by timestamp desc limit ${limit}`;

  const rows = await runEndpointQuery(op, sql, fromIso, toIso);
  return rows.map((row) => ({
    ts: tsToIso(row.timestamp),
    level: deriveLevel(source.id, row.metadata),
    service: internals.service,
    event: text(row.event_message),
    metadata: row.metadata ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Canned report metrics — one fixed template each; the only inputs are the
// allowlisted interval, the clamped limit, and the ISO range params.
// NOTE: usage.api-counts is deliberately NOT used (it filters on
// request.url, which vector never populates self-hosted) and there is no
// DB-error chart (the bundle runs log_min_messages=fatal).
// ---------------------------------------------------------------------------

const EDGE_REQUEST_FROM =
  "from edge_logs cross join unnest(metadata) as m " +
  "cross join unnest(m.request) as request";

export interface ApiRequestVolumePoint {
  bucket: string;
  total: number;
  rest: number;
  auth: number;
  storage: number;
  realtime: number;
  functions: number;
}

/** API request counts per time bucket, split by service via request.path. */
export async function apiRequestVolume(
  range: MetricRange,
): Promise<ApiRequestVolumePoint[]> {
  const op = "api-request-volume";
  const { fromIso, toIso, interval } = metricArgs(op, range);
  const sql =
    `select timestamp_trunc(timestamp, ${interval}) as bucket, ` +
    "count(*) as total, " +
    "countif(regexp_contains(request.path, '^/rest')) as rest, " +
    "countif(regexp_contains(request.path, '^/auth/v1')) as auth, " +
    "countif(regexp_contains(request.path, '^/storage/v1')) as storage, " +
    "countif(regexp_contains(request.path, '^/realtime')) as realtime, " +
    "countif(regexp_contains(request.path, '^/functions')) as functions " +
    `${EDGE_REQUEST_FROM} group by 1 order by 1 asc`;
  const rows = await runEndpointQuery(op, sql, fromIso, toIso);
  return rows.map((row) => ({
    bucket: tsToIso(row.bucket),
    total: num(row.total),
    rest: num(row.rest),
    auth: num(row.auth),
    storage: num(row.storage),
    realtime: num(row.realtime),
    functions: num(row.functions),
  }));
}

export interface ApiErrorRatePoint {
  bucket: string;
  total: number;
  /** Responses with status_code >= 400 (includes the 5xx count). */
  errors4xx: number;
  /** Responses with status_code >= 500. */
  errors5xx: number;
}

/** API error counts (>=400 / >=500) vs total per time bucket. */
export async function apiErrorRates(
  range: MetricRange,
): Promise<ApiErrorRatePoint[]> {
  const op = "api-error-rates";
  const { fromIso, toIso, interval } = metricArgs(op, range);
  const sql =
    `select timestamp_trunc(timestamp, ${interval}) as bucket, ` +
    "count(*) as total, " +
    "countif(response.status_code >= 400) as errors_4xx, " +
    "countif(response.status_code >= 500) as errors_5xx " +
    "from edge_logs cross join unnest(metadata) as m " +
    "cross join unnest(m.response) as response " +
    "group by 1 order by 1 asc";
  const rows = await runEndpointQuery(op, sql, fromIso, toIso);
  return rows.map((row) => ({
    bucket: tsToIso(row.bucket),
    total: num(row.total),
    errors4xx: num(row.errors_4xx),
    errors5xx: num(row.errors_5xx),
  }));
}

export interface TopRoutesParams {
  from: Date | string;
  to: Date | string;
  /** Clamped to [1, 100]; default 20. */
  limit?: number;
}

export interface TopRoute {
  method: string;
  path: string;
  count: number;
}

/** Most-requested method+path pairs in the range. */
export async function topRoutes(params: TopRoutesParams): Promise<TopRoute[]> {
  const op = "top-routes";
  const limit = clampLimit(op, params.limit, 20, 100);
  const fromIso = isoParam(op, "from", params.from);
  const toIso = isoParam(op, "to", params.to);
  const sql =
    "select request.method as method, request.path as path, " +
    `count(*) as hits ${EDGE_REQUEST_FROM} ` +
    `group by 1, 2 order by 3 desc limit ${limit}`;
  const rows = await runEndpointQuery(op, sql, fromIso, toIso);
  return rows.map((row) => ({
    method: text(row.method),
    path: text(row.path),
    count: num(row.hits),
  }));
}

export interface AuthEventPoint {
  bucket: string;
  level: string;
  count: number;
}

/** Auth (GoTrue) log counts by level per time bucket. */
export async function authEvents(
  range: MetricRange,
): Promise<AuthEventPoint[]> {
  const op = "auth-events";
  const { fromIso, toIso, interval } = metricArgs(op, range);
  const sql =
    `select timestamp_trunc(timestamp, ${interval}) as bucket, ` +
    "m.level as level, count(*) as hits " +
    "from auth_logs cross join unnest(metadata) as m " +
    "group by 1, 2 order by 1 asc";
  const rows = await runEndpointQuery(op, sql, fromIso, toIso);
  return rows.map((row) => ({
    bucket: tsToIso(row.bucket),
    level: levelLabel(row.level),
    count: num(row.hits),
  }));
}

export interface ServiceLogVolumePoint {
  bucket: string;
  service: "realtime" | "storage";
  level: string;
  count: number;
}

/**
 * Realtime + storage log counts by level per time bucket. One fixed
 * template, instantiated for each of the two sources and merged (the two
 * requests avoid leaning on the BQ→PG translator for UNION ALL).
 */
export async function serviceLogVolume(
  range: MetricRange,
): Promise<ServiceLogVolumePoint[]> {
  const op = "service-log-volume";
  const { fromIso, toIso, interval } = metricArgs(op, range);
  const template = (source: "realtime_logs" | "storage_logs"): string =>
    `select timestamp_trunc(timestamp, ${interval}) as bucket, ` +
    "m.level as level, count(*) as hits " +
    `from ${source} cross join unnest(metadata) as m ` +
    "group by 1, 2 order by 1 asc";
  const [realtimeRows, storageRows] = await Promise.all([
    runEndpointQuery(op, template("realtime_logs"), fromIso, toIso),
    runEndpointQuery(op, template("storage_logs"), fromIso, toIso),
  ]);
  const toPoint =
    (service: "realtime" | "storage") =>
    (row: Record<string, unknown>): ServiceLogVolumePoint => ({
      bucket: tsToIso(row.bucket),
      service,
      level: levelLabel(row.level),
      count: num(row.hits),
    });
  return [
    ...realtimeRows.map(toPoint("realtime")),
    ...storageRows.map(toPoint("storage")),
  ].sort((a, b) => a.bucket.localeCompare(b.bucket));
}
