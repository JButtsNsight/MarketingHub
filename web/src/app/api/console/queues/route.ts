import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { MARKETING_GROUP } from "@/lib/requireMarketingUser";
import { isValidIdentifier, quoteIdent } from "@/lib/console/identifiers";
import { runQuery } from "@/lib/console/pgmeta";
import {
  allQueueMetrics,
  archiveMessage,
  deleteMessage,
  listArchived,
  listQueues,
  peekMessages,
  popMessage,
  sendMessage,
} from "@/lib/console/queues";

/**
 * pgmq Queues surface (Studio → Integrations → Queues), gated on the Cognito
 * `marketing` group. All reads (queue overview, live peek, archive listing)
 * are non-destructive; the destructive verbs (send/archive/pop/delete) are
 * additionally guarded by the confirm modal on the client.
 *
 * - GET                          → overview: every queue + its pgmq.metrics
 *                                  + accurate archive-table row count
 * - GET ?queue&mode=live         → peek live messages (backing table, vt untouched)
 * - GET ?queue&mode=archived     → archived messages + accurate archive count
 * - POST   {queue, message}      → send a test message              (201, msgId)
 * - PATCH  {queue, msgId}        → archive one message
 * - DELETE {queue, msgId}        → permanently delete one message
 * - DELETE {queue, pop:true}     → pop (read + delete) the next visible message
 *
 * Queue-name / message-id safety lives in @/lib/console/queues (regex allow-list
 * + existence-check against pgmq.list_queues() before any identifier is spliced).
 * The one place this route builds SQL itself — the archive row count — reuses
 * the same guard: validate the name AND confirm it against the live queue list
 * before quote_ident'ing `pgmq.a_<queue>`. Nothing user-supplied is concatenated
 * raw.
 */

export const dynamic = "force-dynamic";

const MAX_QUEUE_NAME = 63;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** pgmq/data-layer failures are user feedback in a console — surface as 400. */
async function queuesAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("[console:queues]")) {
      return Response.json(
        { error: err.message.replace(/^\[console:queues\] [\w-]+ failed: /, "") },
        { status: 400 },
      );
    }
    throw err;
  }
}

/**
 * Accurate row count of a queue's archive table (`pgmq.a_<queue>`). The name is
 * validated against the regex allow-list AND confirmed present in the live
 * queue set before it is quote_ident'd — the same gate the data layer uses for
 * backing-table reads. Any failure (unexpected shape, missing table) degrades
 * to null so one bad queue never breaks the overview.
 */
async function safeArchiveCount(
  name: string,
  known: Set<string>,
): Promise<number | null> {
  if (!known.has(name) || !isValidIdentifier(name)) return null;
  try {
    const rows = await runQuery(
      `select count(*)::bigint as n from pgmq.${quoteIdent(`a_${name}`)}`,
    );
    return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  } catch {
    return null;
  }
}

async function overview(): Promise<Response> {
  const [queues, metrics] = await Promise.all([listQueues(), allQueueMetrics()]);
  const byName = new Map(metrics.map((m) => [m.queueName, m]));
  const known = new Set(queues.map((q) => q.name));

  const rows = await Promise.all(
    queues.map(async (q) => {
      const m = byName.get(q.name);
      return {
        name: q.name,
        isPartitioned: q.isPartitioned,
        isUnlogged: q.isUnlogged,
        createdAt: q.createdAt,
        queueLength: m?.queueLength ?? 0,
        totalMessages: m?.totalMessages ?? 0,
        newestMsgAgeSec: m?.newestMsgAgeSec ?? null,
        oldestMsgAgeSec: m?.oldestMsgAgeSec ?? null,
        scrapeTime: m?.scrapeTime ?? null,
        archiveCount: await safeArchiveCount(q.name, known),
      };
    }),
  );

  return Response.json({ queues: rows });
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  const url = new URL(req.url);
  const queue = url.searchParams.get("queue");
  if (!queue) {
    return overview();
  }

  // Anything that is not an explicit archive request is a live peek.
  const mode = url.searchParams.get("mode") === "archived" ? "archived" : "live";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit != null ? Number(rawLimit) : undefined;

  if (mode === "archived") {
    const messages = await queuesAttempt(() => listArchived(queue, limit));
    if (messages instanceof Response) return messages;
    const count = await safeArchiveCount(queue, new Set([queue]));
    return Response.json({ messages, count });
  }

  const messages = await queuesAttempt(() => peekMessages(queue, limit));
  if (messages instanceof Response) return messages;
  return Response.json({ messages });
}

const SendBodySchema = z.object({
  queue: z.string().min(1).max(MAX_QUEUE_NAME),
  message: z.unknown(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = SendBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const msgId = await queuesAttempt(() =>
    sendMessage(parsed.data.queue, parsed.data.message),
  );
  if (msgId instanceof Response) return msgId;
  return Response.json({ msgId }, { status: 201 });
}

const ArchiveBodySchema = z.object({
  queue: z.string().min(1).max(MAX_QUEUE_NAME),
  msgId: z.number().int().nonnegative().safe(),
});

export async function PATCH(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ArchiveBodySchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const archived = await queuesAttempt(() =>
    archiveMessage(parsed.data.queue, parsed.data.msgId),
  );
  if (archived instanceof Response) return archived;
  return Response.json({ archived });
}

const DeleteBodySchema = z.union([
  z.object({
    queue: z.string().min(1).max(MAX_QUEUE_NAME),
    msgId: z.number().int().nonnegative().safe(),
  }),
  z.object({
    queue: z.string().min(1).max(MAX_QUEUE_NAME),
    pop: z.literal(true),
  }),
]);

export async function DELETE(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
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

  const body = parsed.data;
  if ("msgId" in body) {
    const { queue, msgId } = body;
    const deleted = await queuesAttempt(() => deleteMessage(queue, msgId));
    if (deleted instanceof Response) return deleted;
    return Response.json({ deleted });
  }

  const { queue } = body;
  const message = await queuesAttempt(() => popMessage(queue));
  if (message instanceof Response) return message;
  return Response.json({ popped: message });
}
