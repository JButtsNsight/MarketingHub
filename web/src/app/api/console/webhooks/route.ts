import { z } from "zod";

import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import { OBJECT_SCHEMAS } from "@/lib/console/dbobjects";
import { isValidIdentifier, quoteLiteral } from "@/lib/console/identifiers";
import { listTables, runQuery } from "@/lib/console/pgmeta";
import {
  createWebhook,
  dropWebhook,
  listWebhooks,
  WEBHOOKS_ADMIN_ROLE,
  type DatabaseWebhook,
} from "@/lib/console/webhooks";

/**
 * Database Webhooks (Studio → Database → Webhooks), gated on the Cognito
 * platform section. A database webhook is an AFTER-row trigger whose function
 * is `supabase_functions.http_request(...)`, which dispatches the outbound call
 * through pg_net — the foundation `webhooks` lib owns that convention and all
 * of the SQL-safety (identifier regex + live existence checks, values via
 * quote_literal, event/method whitelists) and the dedicated-role gate.
 *
 * - GET    → every webhook (trigger→http_request), the live table list for the
 *            create picker, and a `ready` flag (does the `webhooks_admin` role
 *            exist — i.e. has cdk/sql/2026-08-07-scope-pg-net.sql been applied).
 * - POST   → createWebhook (refused unless the role + http_request fn + table
 *            all exist).
 * - DELETE → dropWebhook (drops ONLY a confirmed http_request trigger).
 *
 * This route builds NO DDL itself; the only SQL it assembles is the readiness
 * probe, whose sole value is a compile-time constant passed through
 * `quoteLiteral`. Every create/drop delegates to the foundation lib, so nothing
 * caller-supplied is ever concatenated into SQL run as supabase_admin. Each
 * mutating verb is a write; the client puts it behind the confirm modal
 * (controls-match-risk: guard the write, not the browse).
 */

export const dynamic = "force-dynamic";

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/**
 * webhooks / pg-meta failures (bad identifier, missing role, unknown table,
 * duplicate trigger name) are user feedback in this editor — surface as a 400
 * with the real message, stripping the internal `[console:*]` prefix.
 */
async function attempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && /^\[console:(webhooks|pgmeta)\] /.test(err.message)) {
      return Response.json(
        { error: err.message.replace(/^\[console:\w+\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shapes returned to the client
// ---------------------------------------------------------------------------

export interface TableRef {
  schema: string;
  name: string;
}

export interface WebhooksResponse {
  webhooks: DatabaseWebhook[];
  availableTables: TableRef[];
  /** Whether the `webhooks_admin` role exists (the scoping migration is applied). */
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Validation (identifiers regex-gated by zod; the lib re-validates + existence-
// checks against the live catalog before any DDL is built)
// ---------------------------------------------------------------------------

const IdentifierSchema = z
  .string()
  .refine(isValidIdentifier, { message: "must be a valid unquoted SQL identifier" });

const CreateBodySchema = z.object({
  schema: IdentifierSchema,
  table: IdentifierSchema,
  name: IdentifierSchema,
  events: z.array(z.enum(["insert", "update", "delete"])).min(1),
  url: z.string().min(1),
  method: z.enum(["POST", "GET"]).optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().optional(),
});

const DeleteBodySchema = z.object({
  schema: IdentifierSchema,
  table: IdentifierSchema,
  name: IdentifierSchema,
});

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
    const [webhooks, tables, readyRows] = await Promise.all([
      listWebhooks(),
      listTables(OBJECT_SCHEMAS),
      runQuery(
        `select exists(
           select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(WEBHOOKS_ADMIN_ROLE)}
         ) as ready`,
      ),
    ]);
    const availableTables: TableRef[] = tables
      .map((t) => ({ schema: t.schema, name: t.name }))
      .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
    const response: WebhooksResponse = {
      webhooks,
      availableTables,
      ready: readyRows[0]?.ready === true,
    };
    return response;
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

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { schema, table, name, events, url, method, headers, timeoutMs } = parsed.data;

  const done = await attempt(async () => {
    await createWebhook({ schema, table, name, events, url, method, headers, timeoutMs });
    return { created: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done, { status: 201 });
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
  const parsed = DeleteBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { schema, table, name } = parsed.data;

  const done = await attempt(async () => {
    await dropWebhook(schema, table, name);
    return { dropped: name };
  });
  if (done instanceof Response) return done;
  return Response.json(done);
}
