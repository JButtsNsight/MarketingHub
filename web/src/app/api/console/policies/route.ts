import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  POLICY_ACTIONS,
  POLICY_COMMANDS,
  alterPolicy,
  createPolicy,
  dropPolicy,
  listPolicies,
  type PolicyAction,
  type PolicyCommand,
} from "@/lib/console/policies";
import { isValidIdentifier } from "@/lib/console/identifiers";
import { listEditorTables } from "@/lib/console/tables";

/**
 * RLS policies (Studio → Auth → Policies / Database → Policies), gated on the
 * platform section.
 *
 * - GET    → every policy in the managed schemas plus the live table list (with
 *            RLS state) for the coverage view and the create-form picker.
 * - POST   → CREATE POLICY (command/action/roles/using/check).
 * - PATCH  → ALTER POLICY (rename + TO/USING/WITH CHECK).
 * - DELETE → DROP POLICY.
 *
 * All three writes delegate to the foundation `@/lib/console/policies`
 * mutators, which run the DDL as `supabase_admin`. Under that contract every
 * identifier (schema, table, policy name, new name, TO-clause roles) is
 * regex-validated (here by zod AND again in the lib) and existence-checked
 * against the live catalog before any statement is built; command/action come
 * from the fixed whitelists; and the USING / WITH CHECK expressions are raw SQL
 * booleans owned by the caller (the same superuser trust boundary as the SQL
 * editor — see the lib header). No caller string is ever concatenated raw.
 *
 * Every mutating verb is a DDL write; the client puts each behind the confirm
 * modal (guard the write, not the browse). A thrown
 * `[console:policies|pgmeta] <op> failed: <msg>` surfaces as a 400 with the
 * bare Postgres message, exactly like /api/console/rows does for
 * [console:tables].
 */

export const dynamic = "force-dynamic";

/** The PostgREST-exposed schemas the console manages policies for. */
const POLICY_SCHEMAS = ["marketinghub", "public", "storage"];

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * policies / pgmeta failures (bad identifier, missing table/policy, duplicate
 * name, malformed expression) are user feedback in this editor — surface as a
 * 400 with the real message, stripping the internal `[console:*]` prefix.
 */
async function attempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (
      err instanceof Error &&
      /^\[console:(policies|pgmeta)\] /.test(err.message)
    ) {
      return Response.json(
        { error: err.message.replace(/^\[console:\w+\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation — identifiers regex-gated by zod (the lib re-checks); command /
// action against the fixed whitelists; expressions are opaque bounded strings.
// ---------------------------------------------------------------------------

const IdentifierSchema = z
  .string()
  .refine(isValidIdentifier, { message: "must be a valid unquoted SQL identifier" });

const CommandSchema = z
  .string()
  .refine((c) => (POLICY_COMMANDS as readonly string[]).includes(c.toUpperCase()), {
    message: "unsupported command",
  });

const ActionSchema = z
  .string()
  .refine((a) => (POLICY_ACTIONS as readonly string[]).includes(a.toUpperCase()), {
    message: "unsupported action",
  });

// `public` (the PUBLIC pseudo-role) is a valid identifier, so the role list is
// just identifiers; the lib emits `public` as the bare keyword.
const RolesSchema = z.array(IdentifierSchema).max(64);

const ExpressionSchema = z.string().min(1).max(10_000);

const CreateSchema = z.object({
  schema: IdentifierSchema,
  table: IdentifierSchema,
  name: IdentifierSchema,
  command: CommandSchema.optional(),
  action: ActionSchema.optional(),
  roles: RolesSchema.optional(),
  using: ExpressionSchema.nullish(),
  check: ExpressionSchema.nullish(),
});

const AlterSchema = z
  .object({
    schema: IdentifierSchema,
    table: IdentifierSchema,
    name: IdentifierSchema,
    newName: IdentifierSchema.optional(),
    roles: RolesSchema.optional(),
    using: ExpressionSchema.nullish(),
    check: ExpressionSchema.nullish(),
  })
  .refine(
    (b) =>
      b.newName !== undefined ||
      b.roles !== undefined ||
      b.using != null ||
      b.check != null,
    { message: "no changes provided" },
  );

const DeleteSchema = z.object({
  schema: IdentifierSchema,
  table: IdentifierSchema,
  name: IdentifierSchema,
});

async function readJson(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const result = await attempt(async () => {
    const [policies, tables] = await Promise.all([
      listPolicies(POLICY_SCHEMAS),
      listEditorTables(),
    ]);
    return {
      policies,
      tables: tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        rlsEnabled: t.rlsEnabled,
      })),
    };
  });
  if (result instanceof Response) return result;
  return Response.json(result);
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await readJson(req);
  if (payload instanceof Response) return payload;
  const parsed = CreateSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { schema, table, name, command, action, roles, using, check } = parsed.data;

  const done = await attempt(async () => {
    await createPolicy({
      schema,
      table,
      name,
      command: command as PolicyCommand | undefined,
      action: action as PolicyAction | undefined,
      roles,
      using: using ?? null,
      check: check ?? null,
    });
    return { created: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done, { status: 201 });
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await readJson(req);
  if (payload instanceof Response) return payload;
  const parsed = AlterSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { schema, table, name, newName, roles, using, check } = parsed.data;

  const done = await attempt(async () => {
    await alterPolicy({
      schema,
      table,
      name,
      newName,
      roles,
      using: using ?? undefined,
      check: check ?? undefined,
    });
    return { altered: newName ?? name };
  });
  if (done instanceof Response) return done;
  return Response.json(done);
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const payload = await readJson(req);
  if (payload instanceof Response) return payload;
  const parsed = DeleteSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { schema, table, name } = parsed.data;

  const done = await attempt(async () => {
    await dropPolicy(schema, table, name);
    return { dropped: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done);
}
