import "server-only";

import { OBJECT_SCHEMAS } from "./dbobjects";
import { runQuery } from "./pgmeta";
import {
  assertSafeInteger,
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "./identifiers";

/**
 * Database-webhooks data layer (Studio → Database → Webhooks). A Supabase
 * database webhook is nothing more than an AFTER row trigger whose function is
 * `supabase_functions.http_request(...)` — that function, in turn, makes the
 * outbound call through `pg_net` (net.http_post / net.http_get). We adopt that
 * exact convention so webhooks created here look identical to Studio's.
 *
 * DEDICATED-ROLE GATE: outbound HTTP from inside Postgres is an SSRF/exfil
 * surface, so `net.*` EXECUTE is scoped to the `webhooks_admin` role (+ the
 * server-only service_role) by cdk/sql/2026-08-07-scope-pg-net.sql. Creating a
 * webhook is refused unless that role exists — i.e. unless the scoping
 * migration has been applied — so this surface can never light up while pg_net
 * is still under the blanket lockdown.
 *
 * SQL SAFETY: `runQuery` runs as `supabase_admin` (SUPERUSER). Every identifier
 * (schema, table, trigger name) is regex-validated against the allow-list and
 * existence-checked against live catalog before being quoted; the event list is
 * mapped through a fixed keyword whitelist; the URL is parsed + scheme-checked;
 * method comes from a whitelist; headers/params/timeout reach SQL only as
 * `quote_literal`s. Nothing user-supplied is concatenated raw.
 *
 * The route layer maps any thrown `[console:webhooks] <op> failed: <msg>` to a
 * 400 with the bare message (mirroring tables.ts / dbobjects.ts).
 */

/** The role that `net.*` EXECUTE is scoped to (see the scoping migration). */
export const WEBHOOKS_ADMIN_ROLE = "webhooks_admin";

/** The Supabase trigger function every database webhook dispatches through. */
const HTTP_REQUEST_SCHEMA = "supabase_functions";
const HTTP_REQUEST_FUNCTION = "http_request";

export const WEBHOOK_EVENTS = ["insert", "update", "delete"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_METHODS = ["POST", "GET"] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function fail(op: string, message: string): never {
  throw new Error(`[console:webhooks] ${op} failed: ${message}`);
}

async function probe(sql: string): Promise<boolean> {
  const rows = await runQuery(sql);
  return rows[0]?.found === true;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface DatabaseWebhook {
  schema: string;
  table: string;
  name: string;
  /** Row events the trigger fires on (from tgtype bits). */
  events: WebhookEvent[];
  enabled: boolean;
  /** Best-effort target URL parsed from the trigger definition; null if opaque. */
  url: string | null;
  /** Best-effort HTTP method parsed from the trigger definition. */
  method: string | null;
  /** The full `pg_get_triggerdef` text — the source of truth. */
  definition: string;
}

export interface CreateWebhookInput {
  schema: string;
  table: string;
  name: string;
  events: WebhookEvent[];
  url: string;
  /** Defaults to POST. */
  method?: WebhookMethod;
  /** Defaults to `{ "Content-Type": "application/json" }`. */
  headers?: Record<string, string>;
  /** net timeout in ms; defaults to 5000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Unescape a Postgres single-quoted literal captured from a triggerdef. */
function unquote(literal: string): string {
  return literal.replace(/''/g, "'");
}

/** Best-effort extract of the first two http_request args (url, method). */
function parseTarget(definition: string): { url: string | null; method: string | null } {
  const m = definition.match(
    /http_request\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/i,
  );
  if (!m) return { url: null, method: null };
  return { url: unquote(m[1]), method: unquote(m[2]) };
}

/**
 * Every database webhook across the managed schemas: triggers whose function is
 * `supabase_functions.http_request`. Events are decoded from `tgtype` bits
 * (INSERT=4, DELETE=8, UPDATE=16); url/method are best-effort-parsed from the
 * definition (the definition itself is always returned verbatim).
 */
export async function listWebhooks(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<DatabaseWebhook[]> {
  const schemaList = schemas.map((s) => quoteLiteral(s)).join(", ");
  const rows = await runQuery(
    `select n.nspname as schema,
            c.relname as "table",
            t.tgname as name,
            (t.tgtype & 4) <> 0 as on_insert,
            (t.tgtype & 8) <> 0 as on_delete,
            (t.tgtype & 16) <> 0 as on_update,
            (t.tgenabled <> 'D') as enabled,
            pg_catalog.pg_get_triggerdef(t.oid) as definition
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_proc fp on fp.oid = t.tgfoid
       join pg_catalog.pg_namespace fn on fn.oid = fp.pronamespace
      where not t.tgisinternal
        and fn.nspname = ${quoteLiteral(HTTP_REQUEST_SCHEMA)}
        and fp.proname = ${quoteLiteral(HTTP_REQUEST_FUNCTION)}
        and n.nspname in (${schemaList})
      order by n.nspname, c.relname, t.tgname`,
  );
  return rows.map((r) => {
    const definition = String(r.definition ?? "");
    const events: WebhookEvent[] = [];
    if (r.on_insert === true) events.push("insert");
    if (r.on_update === true) events.push("update");
    if (r.on_delete === true) events.push("delete");
    const { url, method } = parseTarget(definition);
    return {
      schema: String(r.schema),
      table: String(r.table),
      name: String(r.name),
      events,
      enabled: r.enabled === true,
      url,
      method,
      definition,
    };
  });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function assertWebhooksRole(op: string): Promise<void> {
  const found = await probe(
    `select exists(
       select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(WEBHOOKS_ADMIN_ROLE)}
     ) as found`,
  );
  if (!found) {
    fail(
      op,
      `the ${WEBHOOKS_ADMIN_ROLE} role does not exist — apply ` +
        `cdk/sql/2026-08-07-scope-pg-net.sql before creating webhooks`,
    );
  }
}

async function assertHttpRequestFn(op: string): Promise<void> {
  const found = await probe(
    `select exists(
       select 1 from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${quoteLiteral(HTTP_REQUEST_SCHEMA)}
        and p.proname = ${quoteLiteral(HTTP_REQUEST_FUNCTION)}
     ) as found`,
  );
  if (!found) {
    fail(op, `${HTTP_REQUEST_SCHEMA}.${HTTP_REQUEST_FUNCTION} is not installed on this database`);
  }
}

async function assertTableExists(op: string, schema: string, table: string): Promise<void> {
  const found = await probe(
    `select exists(
       select 1
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${quoteLiteral(schema)}
          and c.relname = ${quoteLiteral(table)}
          and c.relkind in ('r', 'p')
     ) as found`,
  );
  if (!found) fail(op, `table ${schema}.${table} does not exist`);
}

/** Confirm a trigger exists AND is a webhook (http_request) trigger. */
async function assertWebhookTrigger(
  op: string,
  schema: string,
  table: string,
  name: string,
): Promise<void> {
  const found = await probe(
    `select exists(
       select 1
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_proc fp on fp.oid = t.tgfoid
         join pg_catalog.pg_namespace fn on fn.oid = fp.pronamespace
        where not t.tgisinternal
          and n.nspname = ${quoteLiteral(schema)}
          and c.relname = ${quoteLiteral(table)}
          and t.tgname = ${quoteLiteral(name)}
          and fn.nspname = ${quoteLiteral(HTTP_REQUEST_SCHEMA)}
          and fp.proname = ${quoteLiteral(HTTP_REQUEST_FUNCTION)}
     ) as found`,
  );
  if (!found) fail(op, `webhook ${name} on ${schema}.${table} does not exist`);
}

/** Canonical event keyword list (deduped, fixed order) from validated input. */
function eventClause(op: string, events: WebhookEvent[]): string {
  if (!Array.isArray(events) || events.length === 0) {
    fail(op, "at least one event (insert/update/delete) is required");
  }
  const seen = new Set<WebhookEvent>();
  for (const e of events) {
    if (!WEBHOOK_EVENTS.includes(e)) fail(op, `unsupported event: ${e}`);
    seen.add(e);
  }
  // Emit in a stable order; the keywords are whitelist literals, not user text.
  return WEBHOOK_EVENTS.filter((e) => seen.has(e)).join(" or ");
}

function assertUrl(op: string, url: string): void {
  if (typeof url !== "string" || url.length === 0) fail(op, "url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(op, `invalid url: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(op, `url must use http or https: ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/**
 * Create a database webhook: an AFTER-row trigger on `schema.table` that calls
 * `supabase_functions.http_request(url, method, headers, params, timeout)`.
 * Refused unless the `webhooks_admin` role and the http_request function both
 * exist and the target table is live. A duplicate trigger name errors in
 * Postgres and surfaces as a 400.
 */
export async function createWebhook(input: CreateWebhookInput): Promise<void> {
  const { schema, table, name, events, url } = input;
  if (!isValidIdentifier(schema)) fail("create", `invalid schema: ${schema}`);
  if (!OBJECT_SCHEMAS.includes(schema)) fail("create", `schema not managed here: ${schema}`);
  if (!isValidIdentifier(table)) fail("create", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("create", `invalid webhook name: ${name}`);

  const method = (input.method ?? "POST") as WebhookMethod;
  if (!WEBHOOK_METHODS.includes(method)) fail("create", `unsupported method: ${input.method}`);

  const events_ = eventClause("create", events);
  assertUrl("create", url);

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertSafeInteger(timeoutMs, "timeout");
  if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("create", `timeout must be between 1 and ${MAX_TIMEOUT_MS} ms`);
  }

  const headers = input.headers ?? DEFAULT_HEADERS;
  let headersJson: string;
  try {
    headersJson = JSON.stringify(headers ?? {});
  } catch {
    fail("create", "headers are not JSON-serializable");
  }

  await assertWebhooksRole("create");
  await assertHttpRequestFn("create");
  await assertTableExists("create", schema, table);

  await runQuery(
    `create trigger ${quoteIdent(name)} ` +
      `after ${events_} on ${quoteQualified(schema, table)} ` +
      `for each row execute function ${quoteIdent(HTTP_REQUEST_SCHEMA)}.${quoteIdent(HTTP_REQUEST_FUNCTION)}(` +
      `${quoteLiteral(url)}, ` +
      `${quoteLiteral(method)}, ` +
      `${quoteLiteral(headersJson)}, ` +
      `${quoteLiteral("{}")}, ` +
      `${quoteLiteral(String(timeoutMs))}` +
      `)`,
  );
}

/**
 * Drop a database webhook. Refuses to touch anything that is not a webhook
 * (http_request) trigger — arbitrary trigger removal lives in dbobjects.
 */
export async function dropWebhook(
  schema: string,
  table: string,
  name: string,
): Promise<void> {
  if (!isValidIdentifier(schema)) fail("drop", `invalid schema: ${schema}`);
  if (!isValidIdentifier(table)) fail("drop", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("drop", `invalid webhook name: ${name}`);
  await assertWebhookTrigger("drop", schema, table, name);
  await runQuery(`drop trigger ${quoteIdent(name)} on ${quoteQualified(schema, table)}`);
}
