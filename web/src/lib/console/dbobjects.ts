import "server-only";

import { listExtensions, runQuery, type PgExtension } from "./pgmeta";
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
// Roles (read-only — creating/dropping roles is platform surgery, not console)
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
