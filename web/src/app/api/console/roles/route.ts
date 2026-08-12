import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { listRoles } from "@/lib/console/dbobjects";
import { runQuery } from "@/lib/console/pgmeta";
import {
  assertSafeInteger,
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
} from "@/lib/console/identifiers";
import type { RoleMembership } from "@/components/console/RolesClient";

/**
 * Database → Roles, gated on the platform section. GET lists pg_roles
 * (via the foundation lib) plus their memberships (pg_auth_members); POST/PATCH/
 * DELETE create/alter/drop a role. Every write is DDL run as `supabase_admin`,
 * so the role name is validated against the identifier allow-list and quoted,
 * connection limits go through assertSafeInteger, and passwords / valid-until
 * are passed as SQL literals — no caller string is ever concatenated raw.
 *
 * GAP: @/lib/console/dbobjects intentionally exposes roles read-only
 * (listRoles), so the membership reader and the create/alter/drop mutators live
 * here (stubbed in-surface, per the build rules) rather than in the foundation.
 *
 * A `[console:roles|dbobjects|pgmeta]` error surfaces as a 400 with the real
 * Postgres message, exactly like /api/console/rows does for [console:tables].
 */

export const dynamic = "force-dynamic";

/**
 * Platform-critical roles the console refuses to ALTER or DROP: nuking or
 * re-privileging any of these breaks the whole Supabase stack. Creating custom
 * roles and managing them stays open; touch these via a migration / the SQL
 * editor instead. `pg_*` (Postgres predefined roles) are covered by the prefix.
 */
const RESERVED_ROLES = new Set([
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

function isReservedRole(name: string): boolean {
  return RESERVED_ROLES.has(name) || /^pg_/i.test(name);
}

function rolesFail(op: string, message: string): never {
  throw new Error(`[console:roles] ${op} failed: ${message}`);
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** DDL/read failures (bad/absent/reserved role, dependent objects) are 400s. */
async function dbAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error) {
      const stripped = err.message
        .replace(/^\[console:roles\] [\w-]+ failed: /, "")
        .replace(/^\[console:dbobjects\] [\w-]+ failed: /, "")
        .replace(/^\[console:pgmeta\] query failed: /, "");
      if (stripped !== err.message) {
        return Response.json({ error: stripped }, { status: 400 });
      }
    }
    throw err;
  }
}

/** Read pg_auth_members (foundation gap — see file header). Parameter-free. */
async function listRoleMemberships(): Promise<RoleMembership[]> {
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

interface RoleAttributes {
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
    parts.push(`CONNECTION LIMIT ${assertSafeInteger(attrs.connectionLimit, `${op} connection limit`)}`);
  }
  if (attrs.validUntil !== undefined) {
    const value = attrs.validUntil === null || attrs.validUntil === "" ? "infinity" : attrs.validUntil;
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
  const rows = await runQuery(
    `select exists(
       select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(name)}
     ) as found`,
  );
  return rows[0]?.found === true;
}

/** CREATE ROLE. Duplicate/reserved-prefix names error in Postgres → surfaced 400. */
async function createRole(name: string, attrs: RoleAttributes): Promise<void> {
  if (!isValidIdentifier(name)) rolesFail("create-role", `invalid role name: ${JSON.stringify(name)}`);
  const opts = buildRoleOptions("create-role", attrs);
  await runQuery(
    `create role ${quoteIdent(name)}${opts.length > 0 ? ` with ${opts.join(" ")}` : ""}`,
  );
}

/** ALTER ROLE. Refuses reserved roles; existence-checked before building SQL. */
async function alterRole(name: string, attrs: RoleAttributes): Promise<void> {
  if (!isValidIdentifier(name)) rolesFail("alter-role", `invalid role name: ${JSON.stringify(name)}`);
  if (isReservedRole(name)) {
    rolesFail("alter-role", `${name} is a protected platform role — alter it via a migration / the SQL editor`);
  }
  if (!(await roleExists(name))) rolesFail("alter-role", `role ${name} does not exist`);
  const opts = buildRoleOptions("alter-role", attrs);
  if (opts.length === 0) rolesFail("alter-role", "no attributes provided to change");
  await runQuery(`alter role ${quoteIdent(name)} with ${opts.join(" ")}`);
}

/** DROP ROLE. Refuses reserved roles; existence-checked before building SQL. */
async function dropRole(name: string): Promise<void> {
  if (!isValidIdentifier(name)) rolesFail("drop-role", `invalid role name: ${JSON.stringify(name)}`);
  if (isReservedRole(name)) {
    rolesFail("drop-role", `${name} is a protected platform role — refusing to drop it`);
  }
  if (!(await roleExists(name))) rolesFail("drop-role", `role ${name} does not exist`);
  await runQuery(`drop role ${quoteIdent(name)}`);
}

const identifier = z
  .string()
  .refine(isValidIdentifier, { message: "invalid identifier" });

const attributeShape = {
  canLogin: z.boolean().optional(),
  isSuperuser: z.boolean().optional(),
  canCreateRole: z.boolean().optional(),
  canCreateDb: z.boolean().optional(),
  isReplication: z.boolean().optional(),
  bypassRls: z.boolean().optional(),
  connectionLimit: z.number().int().min(-1).max(1_000_000).optional(),
  validUntil: z.string().max(128).nullable().optional(),
  password: z.string().min(1).max(1024).nullable().optional(),
};

const CreateSchema = z.object({ name: identifier, ...attributeShape });
const AlterSchema = z.object({ name: identifier, ...attributeShape });
const DeleteSchema = z.object({ name: identifier });

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const result = await dbAttempt(async () => ({
    roles: await listRoles(),
    memberships: await listRoleMemberships(),
  }));
  if (result instanceof Response) return result;
  return Response.json(result);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, ...attrs } = parsed.data;
  const result = await dbAttempt(() => createRole(name, attrs));
  if (result instanceof Response) return result;
  return Response.json({ ok: true, name }, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = AlterSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { name, ...attrs } = parsed.data;
  const result = await dbAttempt(() => alterRole(name, attrs));
  if (result instanceof Response) return result;
  return Response.json({ ok: true, name });
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = DeleteSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await dbAttempt(() => dropRole(parsed.data.name));
  if (result instanceof Response) return result;
  return Response.json({ ok: true });
}
