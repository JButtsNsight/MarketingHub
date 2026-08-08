import "server-only";

import { listColumns, listExtensions, listTables, runQuery, type PgExtension } from "./pgmeta";
import {
  assertSafeInteger,
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "./identifiers";

/**
 * Database-objects data layer for the console's Studio-parity pages: roles,
 * functions, triggers, indexes, enum types, publications, and extensions.
 *
 * Readers introspect `pg_catalog` through `runQuery` (superuser). Mutators are
 * DDL — every one validates its identifiers against BOTH the regex allow-list
 * (identifiers.ts) and live introspection (existence-check) BEFORE splicing a
 * quoted identifier into a statement, and passes all values as `quote_literal`.
 * No user string is ever concatenated raw into SQL run as `supabase_admin`.
 *
 * The route layer maps any thrown `[console:dbobjects] <op> failed: <msg>`
 * to a 400 (mirroring tables.ts / pgmeta.ts).
 */

/** Schemas the object pages surface; `pg_catalog`/`information_schema` hidden. */
export const OBJECT_SCHEMAS = ["public", "marketinghub", "storage"];

function fail(op: string, message: string): never {
  throw new Error(`[console:dbobjects] ${op} failed: ${message}`);
}

/** SQL list of quoted schema literals for an `in (...)` filter. */
function schemaInList(schemas: string[] = OBJECT_SCHEMAS): string {
  return schemas.map((s) => quoteLiteral(s)).join(", ");
}

/** Run an `select exists(...) as found` probe; true when the row reports found. */
async function probe(sql: string): Promise<boolean> {
  const rows = await runQuery(sql);
  return rows[0]?.found === true;
}

// ---------------------------------------------------------------------------
// Roles
//
// Listing + membership are plain catalog reads. CREATE/ALTER/DROP ROLE are DDL
// run as `supabase_admin`, so the role name is validated against the identifier
// allow-list and quoted, connection limits go through `assertSafeInteger`
// (spliced unquoted), and password / valid-until reach SQL only as literals.
// Platform-critical roles (service_role, supabase_*, pg_*, …) are refused for
// ALTER/DROP — re-privileging or dropping them breaks the whole stack; touch
// those via a migration / the SQL editor instead.
// ---------------------------------------------------------------------------

export interface PgRole {
  name: string;
  isSuperuser: boolean;
  canLogin: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  isReplication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
  validUntil: string | null;
}

/** One `pg_auth_members` edge: `member` is granted into the group role `role`. */
export interface RoleMembership {
  role: string;
  member: string;
  adminOption: boolean;
  grantor: string | null;
}

/** The typed attribute bag CREATE/ALTER ROLE accept (all optional). */
export interface RoleAttributes {
  canLogin?: boolean;
  isSuperuser?: boolean;
  canCreateRole?: boolean;
  canCreateDb?: boolean;
  isReplication?: boolean;
  bypassRls?: boolean;
  connectionLimit?: number;
  validUntil?: string | null;
  password?: string | null;
}

/**
 * Roles the console refuses to ALTER or DROP: nuking or re-privileging any of
 * these breaks the Supabase stack. `pg_*` (Postgres predefined roles) are
 * covered by the prefix test.
 */
export const RESERVED_ROLES = new Set([
  "postgres",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "supabase_read_only_user",
  "supabase_replication_admin",
  "authenticator",
  "anon",
  "authenticated",
  "service_role",
  "dashboard_user",
  "pgbouncer",
]);

export function isReservedRole(name: string): boolean {
  return RESERVED_ROLES.has(name) || /^pg_/i.test(name);
}

export async function listRoles(): Promise<PgRole[]> {
  const rows = await runQuery(
    `select rolname as name,
            rolsuper as is_superuser,
            rolcanlogin as can_login,
            rolcreaterole as can_create_role,
            rolcreatedb as can_create_db,
            rolreplication as is_replication,
            rolbypassrls as bypass_rls,
            rolconnlimit as connection_limit,
            rolvaliduntil::text as valid_until
       from pg_catalog.pg_roles
      order by rolname`,
  );
  return rows.map((r) => ({
    name: String(r.name),
    isSuperuser: r.is_superuser === true,
    canLogin: r.can_login === true,
    canCreateRole: r.can_create_role === true,
    canCreateDb: r.can_create_db === true,
    isReplication: r.is_replication === true,
    bypassRls: r.bypass_rls === true,
    connectionLimit: Number(r.connection_limit ?? -1),
    validUntil: (r.valid_until as string | null) ?? null,
  }));
}

/** Every `pg_auth_members` grant edge, resolved to role names. Parameter-free. */
export async function listRoleMemberships(): Promise<RoleMembership[]> {
  const rows = await runQuery(
    `select g.rolname as role,
            m.rolname as member,
            am.admin_option as admin_option,
            gr.rolname as grantor
       from pg_catalog.pg_auth_members am
       join pg_catalog.pg_roles g on g.oid = am.roleid
       join pg_catalog.pg_roles m on m.oid = am.member
       left join pg_catalog.pg_roles gr on gr.oid = am.grantor
      order by g.rolname, m.rolname`,
  );
  return rows.map((r) => ({
    role: String(r.role),
    member: String(r.member),
    adminOption: r.admin_option === true,
    grantor: r.grantor == null ? null : String(r.grantor),
  }));
}

/**
 * Turn a typed attribute bag into the `WITH` option words of CREATE/ALTER ROLE.
 * Booleans map to their explicit positive/negative keywords; the connection
 * limit is asserted safe-integer (spliced unquoted); valid-until and password
 * are SQL literals (a null/empty valid-until clears expiry via 'infinity', a
 * null/empty password becomes PASSWORD NULL).
 */
function buildRoleOptions(op: string, attrs: RoleAttributes): string[] {
  const parts: string[] = [];
  if (attrs.canLogin !== undefined) parts.push(attrs.canLogin ? "LOGIN" : "NOLOGIN");
  if (attrs.isSuperuser !== undefined) {
    parts.push(attrs.isSuperuser ? "SUPERUSER" : "NOSUPERUSER");
  }
  if (attrs.canCreateRole !== undefined) {
    parts.push(attrs.canCreateRole ? "CREATEROLE" : "NOCREATEROLE");
  }
  if (attrs.canCreateDb !== undefined) {
    parts.push(attrs.canCreateDb ? "CREATEDB" : "NOCREATEDB");
  }
  if (attrs.isReplication !== undefined) {
    parts.push(attrs.isReplication ? "REPLICATION" : "NOREPLICATION");
  }
  if (attrs.bypassRls !== undefined) {
    parts.push(attrs.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS");
  }
  if (attrs.connectionLimit !== undefined) {
    parts.push(
      `CONNECTION LIMIT ${assertSafeInteger(attrs.connectionLimit, `${op} connection limit`)}`,
    );
  }
  if (attrs.validUntil !== undefined) {
    const value =
      attrs.validUntil === null || attrs.validUntil === "" ? "infinity" : attrs.validUntil;
    parts.push(`VALID UNTIL ${quoteLiteral(value)}`);
  }
  if (attrs.password !== undefined) {
    parts.push(
      attrs.password === null || attrs.password === ""
        ? "PASSWORD NULL"
        : `PASSWORD ${quoteLiteral(attrs.password)}`,
    );
  }
  return parts;
}

async function roleExists(name: string): Promise<boolean> {
  return probe(
    `select exists(
       select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(name)}
     ) as found`,
  );
}

/** CREATE ROLE. Duplicate names error in Postgres → surfaced by the route as 400. */
export async function createRole(name: string, attrs: RoleAttributes = {}): Promise<void> {
  if (!isValidIdentifier(name)) fail("create-role", `invalid role name: ${JSON.stringify(name)}`);
  const opts = buildRoleOptions("create-role", attrs);
  await runQuery(
    `create role ${quoteIdent(name)}${opts.length > 0 ? ` with ${opts.join(" ")}` : ""}`,
  );
}

/** ALTER ROLE. Refuses reserved roles; existence-checked before building SQL. */
export async function alterRole(name: string, attrs: RoleAttributes): Promise<void> {
  if (!isValidIdentifier(name)) fail("alter-role", `invalid role name: ${JSON.stringify(name)}`);
  if (isReservedRole(name)) {
    fail("alter-role", `${name} is a protected platform role — alter it via a migration / the SQL editor`);
  }
  if (!(await roleExists(name))) fail("alter-role", `role ${name} does not exist`);
  const opts = buildRoleOptions("alter-role", attrs);
  if (opts.length === 0) fail("alter-role", "no attributes provided to change");
  await runQuery(`alter role ${quoteIdent(name)} with ${opts.join(" ")}`);
}

/** DROP ROLE. Refuses reserved roles; existence-checked before building SQL. */
export async function dropRole(name: string): Promise<void> {
  if (!isValidIdentifier(name)) fail("drop-role", `invalid role name: ${JSON.stringify(name)}`);
  if (isReservedRole(name)) {
    fail("drop-role", `${name} is a protected platform role — refusing to drop it`);
  }
  if (!(await roleExists(name))) fail("drop-role", `role ${name} does not exist`);
  await runQuery(`drop role ${quoteIdent(name)}`);
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export interface PgFunction {
  oid: number;
  schema: string;
  name: string;
  /** Arg types only (`integer, text`) — the DROP-disambiguating signature. */
  identityArguments: string;
  /** Full arg list incl. names/defaults, for display. */
  arguments: string;
  returnType: string;
  language: string;
  kind: "function" | "procedure" | "aggregate" | "window" | string;
  securityDefiner: boolean;
}

export async function listFunctions(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<PgFunction[]> {
  const rows = await runQuery(
    `select p.oid::int8 as oid,
            n.nspname as schema,
            p.proname as name,
            pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
            pg_catalog.pg_get_function_arguments(p.oid) as arguments,
            pg_catalog.pg_get_function_result(p.oid) as return_type,
            l.lanname as language,
            case p.prokind
              when 'f' then 'function'
              when 'p' then 'procedure'
              when 'a' then 'aggregate'
              when 'w' then 'window'
              else p.prokind::text
            end as kind,
            p.prosecdef as security_definer
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname in (${schemaInList(schemas)})
      order by n.nspname, p.proname`,
  );
  return rows.map((r) => ({
    oid: Number(r.oid),
    schema: String(r.schema),
    name: String(r.name),
    identityArguments: String(r.identity_arguments ?? ""),
    arguments: String(r.arguments ?? ""),
    returnType: String(r.return_type ?? ""),
    language: String(r.language ?? ""),
    kind: String(r.kind ?? "function"),
    securityDefiner: r.security_definer === true,
  }));
}

/**
 * Drop a function by OID. The OID (a validated integer) is the ONLY key: the
 * statement's identifier is derived entirely inside Postgres from
 * `oid::regprocedure` (already fully quoted), so no caller string is ever
 * concatenated as an identifier. Fails loud when the OID is unknown.
 */
export async function dropFunction(oid: number): Promise<void> {
  const id = assertSafeInteger(oid, "function oid");
  await runQuery(
    `do $$
     declare sig text;
     begin
       select p.oid::regprocedure::text into sig
         from pg_catalog.pg_proc p
        where p.oid = ${id};
       if sig is null then
         raise exception 'function with oid ${id} does not exist';
       end if;
       execute 'drop routine ' || sig;
     end $$;`,
  );
}

/**
 * The full definition of one routine, keyed only by its (validated) OID —
 * derived entirely inside Postgres, so no caller string is spliced in.
 * `pg_get_functiondef` is undefined for aggregate/window routines, so those
 * return a null `definition` (the page shows an explanatory note instead).
 * Returns null when the OID is unknown.
 */
export async function getFunctionDefinition(
  oid: number,
): Promise<{ definition: string | null; kind: string } | null> {
  const id = assertSafeInteger(oid, "function oid");
  const rows = await runQuery(
    `select case when p.prokind in ('a', 'w') then null
                 else pg_catalog.pg_get_functiondef(p.oid) end as definition,
            case p.prokind
              when 'f' then 'function'
              when 'p' then 'procedure'
              when 'a' then 'aggregate'
              when 'w' then 'window'
              else p.prokind::text
            end as kind
       from pg_catalog.pg_proc p
      where p.oid = ${id}`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    definition: (row.definition as string | null) ?? null,
    kind: String(row.kind ?? "function"),
  };
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface PgTrigger {
  oid: number;
  schema: string;
  table: string;
  name: string;
  enabled: boolean;
  definition: string;
}

export async function listTriggers(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<PgTrigger[]> {
  const rows = await runQuery(
    `select t.oid::int8 as oid,
            n.nspname as schema,
            c.relname as "table",
            t.tgname as name,
            (t.tgenabled <> 'D') as enabled,
            pg_catalog.pg_get_triggerdef(t.oid) as definition
       from pg_catalog.pg_trigger t
       join pg_catalog.pg_class c on c.oid = t.tgrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal
        and n.nspname in (${schemaInList(schemas)})
      order by n.nspname, c.relname, t.tgname`,
  );
  return rows.map((r) => ({
    oid: Number(r.oid),
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    enabled: r.enabled === true,
    definition: String(r.definition ?? ""),
  }));
}

async function assertTriggerExists(
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
        where not t.tgisinternal
          and n.nspname = ${quoteLiteral(schema)}
          and c.relname = ${quoteLiteral(table)}
          and t.tgname = ${quoteLiteral(name)}
     ) as found`,
  );
  if (!found) fail(op, `trigger ${schema}.${table}.${name} does not exist`);
}

/** Drop a trigger, validated against the regex allow-list + live existence. */
export async function dropTrigger(
  schema: string,
  table: string,
  name: string,
): Promise<void> {
  for (const [part, label] of [
    [schema, "schema"],
    [table, "table"],
    [name, "trigger"],
  ] as const) {
    if (!isValidIdentifier(part)) fail("drop-trigger", `invalid ${label}: ${part}`);
  }
  await assertTriggerExists("drop-trigger", schema, table, name);
  await runQuery(
    `drop trigger ${quoteIdent(name)} on ${quoteQualified(schema, table)}`,
  );
}

/** Enable/disable a trigger without dropping it (Studio's toggle). */
export async function setTriggerEnabled(
  schema: string,
  table: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  for (const [part, label] of [
    [schema, "schema"],
    [table, "table"],
    [name, "trigger"],
  ] as const) {
    if (!isValidIdentifier(part)) fail("set-trigger-enabled", `invalid ${label}: ${part}`);
  }
  await assertTriggerExists("set-trigger-enabled", schema, table, name);
  const verb = enabled ? "enable" : "disable";
  await runQuery(
    `alter table ${quoteQualified(schema, table)} ${verb} trigger ${quoteIdent(name)}`,
  );
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export interface PgIndex {
  schema: string;
  table: string;
  name: string;
  isUnique: boolean;
  isPrimary: boolean;
  definition: string;
  bytes: number;
}

/** `PgIndex` enriched with its `idx_scan` count from pg_stat_user_indexes. */
export interface PgIndexWithStats extends PgIndex {
  idxScan: number;
}

/** Index access methods the console offers — a fixed whitelist, never user text. */
export const INDEX_METHODS = ["btree", "hash", "gin", "gist", "brin", "spgist"] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

export function isIndexMethod(value: unknown): value is IndexMethod {
  return typeof value === "string" && (INDEX_METHODS as readonly string[]).includes(value);
}

export async function listIndexes(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<PgIndex[]> {
  const rows = await runQuery(
    `select ns.nspname as schema,
            tc.relname as "table",
            ic.relname as name,
            i.indisunique as is_unique,
            i.indisprimary as is_primary,
            pg_catalog.pg_get_indexdef(i.indexrelid) as definition,
            pg_catalog.pg_relation_size(i.indexrelid)::int8 as bytes
       from pg_catalog.pg_index i
       join pg_catalog.pg_class ic on ic.oid = i.indexrelid
       join pg_catalog.pg_class tc on tc.oid = i.indrelid
       join pg_catalog.pg_namespace ns on ns.oid = ic.relnamespace
      where ns.nspname in (${schemaInList(schemas)})
      order by ns.nspname, tc.relname, ic.relname`,
  );
  return rows.map((r) => ({
    schema: String(r.schema),
    table: String(r.table),
    name: String(r.name),
    isUnique: r.is_unique === true,
    isPrimary: r.is_primary === true,
    definition: String(r.definition ?? ""),
    bytes: Number(r.bytes ?? 0),
  }));
}

/**
 * Drop an index. Primary-key indexes are refused here (they back a constraint;
 * dropping them means `alter table ... drop constraint`, an intentional
 * different operation).
 */
export async function dropIndex(schema: string, name: string): Promise<void> {
  if (!isValidIdentifier(schema)) fail("drop-index", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("drop-index", `invalid index: ${name}`);
  const rows = await runQuery(
    `select i.indisprimary as is_primary
       from pg_catalog.pg_index i
       join pg_catalog.pg_class ic on ic.oid = i.indexrelid
       join pg_catalog.pg_namespace ns on ns.oid = ic.relnamespace
      where ns.nspname = ${quoteLiteral(schema)}
        and ic.relname = ${quoteLiteral(name)}`,
  );
  if (rows.length === 0) fail("drop-index", `index ${schema}.${name} does not exist`);
  if (rows[0]?.is_primary === true) {
    fail("drop-index", `${schema}.${name} backs a primary key — drop the constraint instead`);
  }
  await runQuery(`drop index ${quoteQualified(schema, name)}`);
}

/**
 * The index list enriched with `idx_scan` scan-counts from
 * `pg_stat_user_indexes` — the shape the Indexes page renders. The base rows
 * come from `listIndexes`; the scan-count is a separate catalog read merged by
 * (schema, table, name) so the page never waterfalls two round-trips itself.
 */
export async function listIndexesWithStats(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<PgIndexWithStats[]> {
  const schemaList = schemas.map((s) => quoteLiteral(s)).join(", ");
  const [indexes, statRows] = await Promise.all([
    listIndexes(schemas),
    runQuery(
      `select schemaname as schema,
              relname as "table",
              indexrelname as name,
              coalesce(idx_scan, 0)::int8 as idx_scan
         from pg_catalog.pg_stat_user_indexes
        where schemaname in (${schemaList})`,
    ),
  ]);
  const scans = new Map<string, number>();
  for (const r of statRows) {
    scans.set(`${r.schema}.${r.table}.${r.name}`, Number(r.idx_scan ?? 0));
  }
  return indexes.map((ix) => ({
    ...ix,
    idxScan: scans.get(`${ix.schema}.${ix.table}.${ix.name}`) ?? 0,
  }));
}

export interface CreateIndexInput {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  method: IndexMethod;
}

/**
 * Build + run a `CREATE [UNIQUE] INDEX` from a STRUCTURED definition. Every
 * identifier is validated against the regex allow-list AND existence-checked
 * against live introspection (the table must be a managed schema; the table and
 * every column must exist) before being quoted; the method comes from the fixed
 * whitelist. No raw definition string is accepted — arbitrary index DDL belongs
 * in the SQL editor.
 */
export async function createIndex(input: CreateIndexInput): Promise<void> {
  const { schema, table, name, columns, unique, method } = input;

  if (!isValidIdentifier(schema)) fail("create-index", `invalid schema: ${schema}`);
  if (!OBJECT_SCHEMAS.includes(schema)) fail("create-index", `schema not managed here: ${schema}`);
  if (!isValidIdentifier(table)) fail("create-index", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("create-index", `invalid index name: ${name}`);
  if (!Array.isArray(columns) || columns.length === 0) {
    fail("create-index", "at least one column is required");
  }
  for (const col of columns) {
    if (!isValidIdentifier(col)) fail("create-index", `invalid column: ${col}`);
  }
  if (!isIndexMethod(method)) fail("create-index", `unsupported index method: ${method}`);

  // Existence-check the table + every column against live introspection, so a
  // syntactically valid but non-existent identifier never reaches the DDL.
  const cols = await listColumns([schema]);
  const inTable = cols.filter((c) => c.table === table);
  if (inTable.length === 0) fail("create-index", `table ${schema}.${table} does not exist`);
  const known = new Set(inTable.map((c) => c.name));
  for (const col of columns) {
    if (!known.has(col)) fail("create-index", `unknown column: ${schema}.${table}.${col}`);
  }

  const colList = columns.map((c) => quoteIdent(c)).join(", ");
  await runQuery(
    `create ${unique ? "unique " : ""}index ${quoteIdent(name)} ` +
      `on ${quoteQualified(schema, table)} using ${method} (${colList})`,
  );
}

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

export interface PgEnumType {
  schema: string;
  name: string;
  values: string[];
}

export async function listEnumTypes(
  schemas: string[] = OBJECT_SCHEMAS,
): Promise<PgEnumType[]> {
  const rows = await runQuery(
    `select n.nspname as schema,
            t.typname as name,
            array_agg(e.enumlabel order by e.enumsortorder) as "values"
       from pg_catalog.pg_type t
       join pg_catalog.pg_namespace n on n.oid = t.typnamespace
       join pg_catalog.pg_enum e on e.enumtypid = t.oid
      where n.nspname in (${schemaInList(schemas)})
      group by n.nspname, t.typname
      order by n.nspname, t.typname`,
  );
  return rows.map((r) => ({
    schema: String(r.schema),
    name: String(r.name),
    values: Array.isArray(r.values) ? (r.values as unknown[]).map(String) : [],
  }));
}

/**
 * Append a value to an enum type. `alter type ... add value` cannot run in a
 * transaction block and cannot be rolled back — hence a guarded, deliberate
 * mutator. Type identifier is validated + existence-checked; the new label is
 * a `quote_literal`.
 */
export async function addEnumValue(
  schema: string,
  name: string,
  value: string,
): Promise<void> {
  if (!isValidIdentifier(schema)) fail("add-enum-value", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("add-enum-value", `invalid type: ${name}`);
  if (typeof value !== "string" || value.length === 0) {
    fail("add-enum-value", "enum value must be a non-empty string");
  }
  const found = await probe(
    `select exists(
       select 1 from pg_catalog.pg_type t
       join pg_catalog.pg_namespace n on n.oid = t.typnamespace
       where t.typtype = 'e'
         and n.nspname = ${quoteLiteral(schema)}
         and t.typname = ${quoteLiteral(name)}
     ) as found`,
  );
  if (!found) fail("add-enum-value", `enum type ${schema}.${name} does not exist`);
  await runQuery(
    `alter type ${quoteQualified(schema, name)} add value if not exists ${quoteLiteral(value)}`,
  );
}

async function enumTypeExists(schema: string, name: string): Promise<boolean> {
  return probe(
    `select exists(
       select 1
         from pg_catalog.pg_type t
         join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        where t.typtype = 'e'
          and n.nspname = ${quoteLiteral(schema)}
          and t.typname = ${quoteLiteral(name)}
     ) as found`,
  );
}

/**
 * Create an enum type from a fixed label set. Schema + type name are validated
 * against the allow-list and existence-checked (schema must exist, type must
 * not) before any quoted identifier reaches DDL; each label is a `quote_literal`.
 */
export async function createEnumType(
  schema: string,
  name: string,
  values: string[],
): Promise<void> {
  if (!isValidIdentifier(schema)) fail("create-enum", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("create-enum", `invalid type: ${name}`);
  if (!Array.isArray(values) || values.length === 0) {
    fail("create-enum", "an enum needs at least one value");
  }
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) {
      fail("create-enum", "enum values must be non-empty strings");
    }
  }
  const schemaFound = await probe(
    `select exists(
       select 1 from pg_catalog.pg_namespace where nspname = ${quoteLiteral(schema)}
     ) as found`,
  );
  if (!schemaFound) fail("create-enum", `schema ${schema} does not exist`);
  if (await enumTypeExists(schema, name)) {
    fail("create-enum", `type ${schema}.${name} already exists`);
  }
  const labels = values.map((v) => quoteLiteral(v)).join(", ");
  await runQuery(`create type ${quoteQualified(schema, name)} as enum (${labels})`);
}

/** Drop an enum type, validated against the allow-list + live existence. */
export async function dropEnumType(schema: string, name: string): Promise<void> {
  if (!isValidIdentifier(schema)) fail("drop-enum", `invalid schema: ${schema}`);
  if (!isValidIdentifier(name)) fail("drop-enum", `invalid type: ${name}`);
  if (!(await enumTypeExists(schema, name))) {
    fail("drop-enum", `enum type ${schema}.${name} does not exist`);
  }
  await runQuery(`drop type ${quoteQualified(schema, name)}`);
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

export interface PgPublication {
  name: string;
  owner: string;
  allTables: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  tableCount: number;
}

export async function listPublications(): Promise<PgPublication[]> {
  const rows = await runQuery(
    `select p.pubname as name,
            r.rolname as owner,
            p.puballtables as all_tables,
            p.pubinsert as "insert",
            p.pubupdate as "update",
            p.pubdelete as "delete",
            p.pubtruncate as "truncate",
            case when p.puballtables then null
                 else (select count(*)::int
                         from pg_catalog.pg_publication_rel pr
                        where pr.prpubid = p.oid)
            end as table_count
       from pg_catalog.pg_publication p
       join pg_catalog.pg_roles r on r.oid = p.pubowner
      order by p.pubname`,
  );
  return rows.map((r) => ({
    name: String(r.name),
    owner: String(r.owner),
    allTables: r.all_tables === true,
    insert: r.insert === true,
    update: r.update === true,
    delete: r.delete === true,
    truncate: r.truncate === true,
    tableCount: r.table_count == null ? -1 : Number(r.table_count),
  }));
}

/** Drop a publication, validated against the allow-list + live existence. */
export async function dropPublication(name: string): Promise<void> {
  if (!isValidIdentifier(name)) fail("drop-publication", `invalid publication: ${name}`);
  const found = await probe(
    `select exists(
       select 1 from pg_catalog.pg_publication where pubname = ${quoteLiteral(name)}
     ) as found`,
  );
  if (!found) fail("drop-publication", `publication ${name} does not exist`);
  await runQuery(`drop publication ${quoteIdent(name)}`);
}

/** The four row operations a publication may replicate. */
export interface PublishOps {
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
}

/** A `schema.table` target for a table-scoped publication. */
export interface PublicationTableRef {
  schema: string;
  table: string;
}

export interface CreatePublicationInput {
  name: string;
  /** FOR ALL TABLES vs. an explicit table set. */
  allTables: boolean;
  tables: PublicationTableRef[];
  publish: PublishOps;
}

export interface AlterPublicationInput {
  name: string;
  publish: PublishOps;
  /** When present + non-empty, replaces the member table set (SET TABLE). */
  tables?: PublicationTableRef[];
}

/** Member tables ("schema.table") per publication, keyed by publication name. */
export async function listPublicationTables(): Promise<Map<string, string[]>> {
  const rows = await runQuery(
    `select pubname, schemaname, tablename
       from pg_catalog.pg_publication_tables
      order by pubname, schemaname, tablename`,
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const pub = String(r.pubname);
    const arr = map.get(pub) ?? [];
    arr.push(`${String(r.schemaname)}.${String(r.tablename)}`);
    map.set(pub, arr);
  }
  return map;
}

/** The `publish = '...'` value from validated booleans — fixed literals only. */
function publishList(op: string, p: PublishOps): string {
  const ops: string[] = [];
  if (p.insert) ops.push("insert");
  if (p.update) ops.push("update");
  if (p.delete) ops.push("delete");
  if (p.truncate) ops.push("truncate");
  if (ops.length === 0) fail(op, "at least one publish operation is required");
  return ops.join(", ");
}

/** Validate every table ref, then existence-check it against live introspection. */
async function assertLiveTables(op: string, tables: PublicationTableRef[]): Promise<void> {
  for (const t of tables) {
    if (!isValidIdentifier(t.schema)) fail(op, `invalid schema: ${t.schema}`);
    if (!isValidIdentifier(t.table)) fail(op, `invalid table: ${t.table}`);
  }
  const live = new Set((await listTables(OBJECT_SCHEMAS)).map((t) => `${t.schema}.${t.name}`));
  for (const t of tables) {
    if (!live.has(`${t.schema}.${t.table}`)) fail(op, `unknown table: ${t.schema}.${t.table}`);
  }
}

/**
 * CREATE PUBLICATION from a structured definition. The name is allow-list
 * validated + quoted; the publish clause is assembled ONLY from fixed literals;
 * table targets are validated AND existence-checked before any DDL is built.
 */
export async function createPublication(input: CreatePublicationInput): Promise<void> {
  const { name, allTables, tables, publish } = input;
  if (!isValidIdentifier(name)) fail("create-publication", `invalid publication: ${name}`);
  if (allTables && tables.length > 0) {
    fail("create-publication", "an all-tables publication cannot also list tables");
  }
  const publishClause = publishList("create-publication", publish);
  let scope = "";
  if (allTables) {
    scope = " for all tables";
  } else if (tables.length > 0) {
    await assertLiveTables("create-publication", tables);
    scope = ` for table ${tables.map((t) => quoteQualified(t.schema, t.table)).join(", ")}`;
  }
  await runQuery(
    `create publication ${quoteIdent(name)}${scope} with (publish = ${quoteLiteral(publishClause)})`,
  );
}

/**
 * ALTER PUBLICATION: always updates the publish operations; when `tables` is
 * present + non-empty, also replaces the member set (Postgres forbids an empty
 * SET TABLE, so an empty/absent selection leaves membership untouched). Refuses
 * a member-set change on an all-tables publication and existence-checks the
 * publication + every table before building DDL.
 */
export async function alterPublication(input: AlterPublicationInput): Promise<void> {
  const { name, publish, tables } = input;
  if (!isValidIdentifier(name)) fail("alter-publication", `invalid publication: ${name}`);
  const publishClause = publishList("alter-publication", publish);

  const rows = await runQuery(
    `select puballtables as all_tables
       from pg_catalog.pg_publication
      where pubname = ${quoteLiteral(name)}`,
  );
  if (rows.length === 0) fail("alter-publication", `publication ${name} does not exist`);
  const isAllTables = rows[0]?.all_tables === true;

  const stmts = [
    `alter publication ${quoteIdent(name)} set (publish = ${quoteLiteral(publishClause)})`,
  ];
  if (tables && tables.length > 0) {
    if (isAllTables) {
      fail("alter-publication", "cannot set member tables on an all-tables publication");
    }
    await assertLiveTables("alter-publication", tables);
    stmts.push(
      `alter publication ${quoteIdent(name)} set table ${tables
        .map((t) => quoteQualified(t.schema, t.table))
        .join(", ")}`,
    );
  }
  await runQuery(stmts.join("; "));
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

/** All extensions pg-meta knows about (installed + available), name-sorted. */
export async function listInstalledExtensions(): Promise<PgExtension[]> {
  const all = await listExtensions();
  return [...all].sort((a, b) => a.name.localeCompare(b.name));
}

async function knownExtension(name: string): Promise<PgExtension | null> {
  const all = await listExtensions();
  return all.find((e) => e.name === name) ?? null;
}

/**
 * Enable an extension. The name is validated against the regex allow-list AND
 * against pg-meta's live catalog of AVAILABLE extensions (so only a real
 * `pg_available_extensions` name is ever spliced in). Optional target schema
 * and version are validated/quoted the same way.
 */
export async function enableExtension(
  name: string,
  opts: { schema?: string; version?: string } = {},
): Promise<void> {
  if (!isValidIdentifier(name)) fail("enable-extension", `invalid extension: ${name}`);
  const ext = await knownExtension(name);
  if (!ext) fail("enable-extension", `unknown extension: ${name}`);

  let sql = `create extension if not exists ${quoteIdent(name)}`;
  if (opts.schema !== undefined) {
    if (!isValidIdentifier(opts.schema)) {
      fail("enable-extension", `invalid schema: ${opts.schema}`);
    }
    sql += ` with schema ${quoteIdent(opts.schema)}`;
  }
  if (opts.version !== undefined) {
    if (typeof opts.version !== "string" || opts.version.length === 0) {
      fail("enable-extension", "version must be a non-empty string");
    }
    sql += `${opts.schema !== undefined ? "" : " with"} version ${quoteLiteral(opts.version)}`;
  }
  await runQuery(sql);
}

/** Drop (disable) an extension. Refused unless it is currently installed. */
export async function dropExtension(name: string): Promise<void> {
  if (!isValidIdentifier(name)) fail("drop-extension", `invalid extension: ${name}`);
  const ext = await knownExtension(name);
  if (!ext) fail("drop-extension", `unknown extension: ${name}`);
  if (ext.installed_version == null) {
    fail("drop-extension", `extension ${name} is not installed`);
  }
  await runQuery(`drop extension ${quoteIdent(name)}`);
}
