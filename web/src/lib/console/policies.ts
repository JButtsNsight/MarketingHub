import "server-only";

import { listPolicies, runQuery, type PgPolicy } from "./pgmeta";
import {
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "./identifiers";

/**
 * RLS-policy data layer for the console's Policy editor (Studio → Auth →
 * Policies / Database → Policies). Reads reuse pg-meta's `listPolicies`; the
 * three mutators are DDL run as `supabase_admin` and are assembled here from
 * `runQuery` + the shared SQL-safety helpers.
 *
 * SQL SAFETY — read this before touching the assembly:
 *   - IDENTIFIERS (schema, table, policy name, new name, TO-clause roles) are
 *     validated against the regex allow-list (identifiers.ts) and quoted, and
 *     the schema.table is existence-checked against live catalog before any DDL
 *     is built. `public` in the role list is the PUBLIC pseudo-role keyword, so
 *     it is emitted bare (never quoted — quoting would target a role literally
 *     named "public").
 *   - COMMAND / ACTION are fixed whitelists (SELECT/INSERT/…, PERMISSIVE/…).
 *   - The `USING` / `WITH CHECK` EXPRESSIONS are, by nature, arbitrary SQL
 *     boolean expressions — Postgres has no way to parameterize them, so they
 *     are spliced verbatim inside parentheses. This is the SAME superuser trust
 *     boundary as the SQL editor: the caller (a Cognito `marketing` admin) owns
 *     what goes in the expression. Everything AROUND the expression is locked
 *     down so a malformed expression can only ever be a syntax error, never a
 *     way to escape the statement it sits in.
 *
 * The route layer maps any thrown `[console:policies] <op> failed: <msg>` to a
 * 400 with the bare message (mirroring tables.ts / dbobjects.ts).
 */

export { listPolicies, type PgPolicy };

function fail(op: string, message: string): never {
  throw new Error(`[console:policies] ${op} failed: ${message}`);
}

async function probe(sql: string): Promise<boolean> {
  const rows = await runQuery(sql);
  return rows[0]?.found === true;
}

// ---------------------------------------------------------------------------
// Whitelists + input shapes
// ---------------------------------------------------------------------------

export const POLICY_COMMANDS = ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

export const POLICY_ACTIONS = ["PERMISSIVE", "RESTRICTIVE"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export interface CreatePolicyInput {
  schema: string;
  table: string;
  name: string;
  /** Defaults to ALL. */
  command?: PolicyCommand;
  /** Defaults to PERMISSIVE. */
  action?: PolicyAction;
  /** TO-clause roles; empty => TO public. */
  roles?: string[];
  /** USING boolean expression (raw SQL). Omit/null to leave it off. */
  using?: string | null;
  /** WITH CHECK boolean expression (raw SQL). Omit/null to leave it off. */
  check?: string | null;
}

export interface AlterPolicyInput {
  schema: string;
  table: string;
  name: string;
  /** New TO-clause roles (replaces the set). */
  roles?: string[];
  using?: string | null;
  check?: string | null;
  /** RENAME TO — applied as its own statement (Postgres cannot combine it). */
  newName?: string;
}

// ---------------------------------------------------------------------------
// Existence checks
// ---------------------------------------------------------------------------

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

async function assertPolicyExists(
  op: string,
  schema: string,
  table: string,
  name: string,
): Promise<void> {
  const found = await probe(
    `select exists(
       select 1 from pg_catalog.pg_policies
        where schemaname = ${quoteLiteral(schema)}
          and tablename = ${quoteLiteral(table)}
          and policyname = ${quoteLiteral(name)}
     ) as found`,
  );
  if (!found) fail(op, `policy ${name} on ${schema}.${table} does not exist`);
}

// ---------------------------------------------------------------------------
// Clause builders (identifiers only — never expressions)
// ---------------------------------------------------------------------------

/** TO-clause from validated role names; `public` is the bare keyword. */
function rolesClause(op: string, roles: string[]): string {
  if (roles.length === 0) return "public";
  return roles
    .map((r) => {
      if (typeof r !== "string") fail(op, `invalid role: ${JSON.stringify(r)}`);
      if (r.toLowerCase() === "public") return "public";
      if (!isValidIdentifier(r)) fail(op, `invalid role: ${r}`);
      return quoteIdent(r);
    })
    .join(", ");
}

/** A non-empty raw expression wrapped in parentheses, or fail. */
function expr(op: string, label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(op, `${label} expression must be a non-empty string`);
  }
  return `(${value})`;
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/**
 * CREATE POLICY. Identifiers validated + quoted, table existence-checked,
 * command/action from the fixed whitelists, roles rendered by `rolesClause`.
 * `using`/`check` are raw expressions (see the file header trust note).
 */
export async function createPolicy(input: CreatePolicyInput): Promise<void> {
  const { schema, table, name } = input;
  if (!isValidIdentifier(schema)) fail("create-policy", `invalid schema: ${schema}`);
  if (!isValidIdentifier(table)) fail("create-policy", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("create-policy", `invalid policy name: ${name}`);

  const command = (input.command ?? "ALL").toUpperCase() as PolicyCommand;
  if (!POLICY_COMMANDS.includes(command)) fail("create-policy", `unsupported command: ${input.command}`);
  const action = (input.action ?? "PERMISSIVE").toUpperCase() as PolicyAction;
  if (!POLICY_ACTIONS.includes(action)) fail("create-policy", `unsupported action: ${input.action}`);

  await assertTableExists("create-policy", schema, table);
  const to = rolesClause("create-policy", input.roles ?? []);

  let sql =
    `create policy ${quoteIdent(name)} on ${quoteQualified(schema, table)} ` +
    `as ${action.toLowerCase()} for ${command.toLowerCase()} to ${to}`;
  if (input.using != null) sql += ` using ${expr("create-policy", "using", input.using)}`;
  if (input.check != null) sql += ` with check ${expr("create-policy", "check", input.check)}`;
  // Enable RLS on the target before adding the policy — a policy on an
  // RLS-disabled table is inert, so Studio's create-policy flow enables RLS
  // too. Without this the templates' "enables RLS / satisfies the gate"
  // promise would not hold and rls-gate.sql would still fail the table.
  await runQuery(
    `alter table ${quoteQualified(schema, table)} enable row level security`,
  );
  await runQuery(sql);
}

/**
 * ALTER POLICY. A rename (if requested) runs as its own statement first, then a
 * combined `TO … / USING … / WITH CHECK …` statement runs against the resulting
 * name. Postgres cannot change a policy's command/action — those are create-only.
 */
export async function alterPolicy(input: AlterPolicyInput): Promise<void> {
  const { schema, table, name } = input;
  if (!isValidIdentifier(schema)) fail("alter-policy", `invalid schema: ${schema}`);
  if (!isValidIdentifier(table)) fail("alter-policy", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("alter-policy", `invalid policy name: ${name}`);
  await assertPolicyExists("alter-policy", schema, table, name);

  const target = quoteQualified(schema, table);
  let current = name;
  if (input.newName !== undefined) {
    if (!isValidIdentifier(input.newName)) {
      fail("alter-policy", `invalid new policy name: ${input.newName}`);
    }
    await runQuery(
      `alter policy ${quoteIdent(name)} on ${target} rename to ${quoteIdent(input.newName)}`,
    );
    current = input.newName;
  }

  const clauses: string[] = [];
  if (input.roles !== undefined) clauses.push(`to ${rolesClause("alter-policy", input.roles)}`);
  if (input.using != null) clauses.push(`using ${expr("alter-policy", "using", input.using)}`);
  if (input.check != null) clauses.push(`with check ${expr("alter-policy", "check", input.check)}`);

  if (clauses.length > 0) {
    await runQuery(`alter policy ${quoteIdent(current)} on ${target} ${clauses.join(" ")}`);
  } else if (input.newName === undefined) {
    fail("alter-policy", "no changes provided");
  }
}

/** DROP POLICY, validated against the allow-list + live existence. */
export async function dropPolicy(schema: string, table: string, name: string): Promise<void> {
  if (!isValidIdentifier(schema)) fail("drop-policy", `invalid schema: ${schema}`);
  if (!isValidIdentifier(table)) fail("drop-policy", `invalid table: ${table}`);
  if (!isValidIdentifier(name)) fail("drop-policy", `invalid policy name: ${name}`);
  await assertPolicyExists("drop-policy", schema, table, name);
  await runQuery(`drop policy ${quoteIdent(name)} on ${quoteQualified(schema, table)}`);
}

// ---------------------------------------------------------------------------
// Templates — starter policies that SATISFY the deny-by-default RLS gate
// (cdk/sql/rls-gate.sql: an exposed table needs RLS ENABLED and ≥1 policy).
// Each template both enables RLS and adds one policy, so applying it flips a
// gate-offending table to compliant. `{{table}}` is the ONLY placeholder and is
// substituted with the quoted, qualified identifier by `renderPolicyTemplate`.
// ---------------------------------------------------------------------------

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  /** Parameterized DDL; `{{table}}` is replaced with a quoted qualified name. */
  sql: string;
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    id: "service_role_full_access",
    name: "Service-role full access",
    description:
      "Enable RLS and grant the server-only service_role unrestricted access. " +
      "The safe default for tables reached only through the service-role data " +
      "plane: satisfies the RLS gate without exposing rows to anon/authenticated.",
    sql:
      `alter table {{table}} enable row level security;\n` +
      `create policy "service_role_full_access"\n` +
      `  on {{table}}\n` +
      `  as permissive\n` +
      `  for all\n` +
      `  to service_role\n` +
      `  using (true)\n` +
      `  with check (true);`,
  },
  {
    id: "owner_access_auth_uid",
    name: "Per-user owner (auth.uid())",
    description:
      "Enable RLS and let each authenticated user read/write only the rows they " +
      "own. Assumes a `user_id uuid` column holding the owner's auth id; rename " +
      "it in the generated SQL if your ownership column differs.",
    sql:
      `alter table {{table}} enable row level security;\n` +
      `create policy "owner_access"\n` +
      `  on {{table}}\n` +
      `  as permissive\n` +
      `  for all\n` +
      `  to authenticated\n` +
      `  using ((select auth.uid()) = user_id)\n` +
      `  with check ((select auth.uid()) = user_id);`,
  },
  {
    id: "public_read_only",
    name: "Read-only public",
    description:
      "Enable RLS and allow anyone (anon + authenticated) to SELECT every row, " +
      "with no write path. Use for genuinely public reference data only.",
    sql:
      `alter table {{table}} enable row level security;\n` +
      `create policy "public_read_only"\n` +
      `  on {{table}}\n` +
      `  as permissive\n` +
      `  for select\n` +
      `  to anon, authenticated\n` +
      `  using (true);`,
  },
];

/**
 * Render a template's SQL for a concrete table. The schema + table are validated
 * against the identifier allow-list and substituted as a quoted qualified name,
 * so the returned SQL is safe to run even though the template body is otherwise
 * fixed text. Throws `[console:policies] render-template failed: …` on a bad id
 * or identifier.
 */
export function renderPolicyTemplate(id: string, schema: string, table: string): string {
  const tpl = POLICY_TEMPLATES.find((t) => t.id === id);
  if (!tpl) fail("render-template", `unknown policy template: ${id}`);
  if (!isValidIdentifier(schema)) fail("render-template", `invalid schema: ${schema}`);
  if (!isValidIdentifier(table)) fail("render-template", `invalid table: ${table}`);
  return tpl.sql.split("{{table}}").join(quoteQualified(schema, table));
}
