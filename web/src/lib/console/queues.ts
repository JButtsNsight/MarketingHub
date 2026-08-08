import "server-only";

import { runQuery } from "./pgmeta";
import {
  assertSafeInteger,
  clampLimit,
  isValidIdentifier,
  quoteIdent,
  quoteLiteral,
} from "./identifiers";

/**
 * pgmq data layer — the console's parity for Studio's "Queues" integration.
 *
 * Reads use the `pgmq` API (`pgmq.list_queues()`, `pgmq.metrics*`) and, for a
 * NON-destructive peek, the queue's own backing tables (`pgmq.q_<queue>` live,
 * `pgmq.a_<queue>` archive). Writes go through the `pgmq_public` wrapper
 * (`send`/`pop`/`archive`/`delete`), the same surface the anon/service roles
 * use.
 *
 * SQL safety: a queue name is a Postgres identifier. Where it is a text
 * ARGUMENT to a pgmq function it is passed as a `quote_literal`; where it forms
 * part of a TABLE name (peek/archive reads) it is validated against the regex
 * allow-list AND existence-checked via `pgmq.list_queues()`, then quoted with
 * `quote_ident`. Message ids are validated integers; message bodies are
 * `quote_literal`'d JSON cast to `jsonb`. Nothing is spliced raw.
 */

function fail(op: string, message: string): never {
  throw new Error(`[console:queues] ${op} failed: ${message}`);
}

export const DEFAULT_PEEK_LIMIT = 25;
export const MAX_PEEK_LIMIT = 100;

export interface PgmqQueue {
  name: string;
  isPartitioned: boolean;
  isUnlogged: boolean;
  createdAt: string | null;
}

export async function listQueues(): Promise<PgmqQueue[]> {
  const rows = await runQuery(
    `select queue_name,
            is_partitioned,
            is_unlogged,
            created_at::text as created_at
       from pgmq.list_queues()
      order by queue_name`,
  );
  return rows.map((r) => ({
    name: String(r.queue_name),
    isPartitioned: r.is_partitioned === true,
    isUnlogged: r.is_unlogged === true,
    createdAt: (r.created_at as string | null) ?? null,
  }));
}

export interface PgmqMetrics {
  queueName: string;
  queueLength: number;
  newestMsgAgeSec: number | null;
  oldestMsgAgeSec: number | null;
  totalMessages: number;
  scrapeTime: string | null;
}

function toMetrics(r: Record<string, unknown>): PgmqMetrics {
  return {
    queueName: String(r.queue_name),
    queueLength: Number(r.queue_length ?? 0),
    newestMsgAgeSec: r.newest_msg_age_sec == null ? null : Number(r.newest_msg_age_sec),
    oldestMsgAgeSec: r.oldest_msg_age_sec == null ? null : Number(r.oldest_msg_age_sec),
    totalMessages: Number(r.total_messages ?? 0),
    scrapeTime: (r.scrape_time as string | null) ?? null,
  };
}

/** Metrics for every queue (pgmq.metrics_all), name-sorted. */
export async function allQueueMetrics(): Promise<PgmqMetrics[]> {
  const rows = await runQuery(
    `select queue_name,
            queue_length,
            newest_msg_age_sec,
            oldest_msg_age_sec,
            total_messages,
            scrape_time::text as scrape_time
       from pgmq.metrics_all()
      order by queue_name`,
  );
  return rows.map(toMetrics);
}

/** Metrics for one queue, or null when the queue is unknown. */
export async function queueMetrics(queueName: string): Promise<PgmqMetrics | null> {
  await assertQueueExists("metrics", queueName);
  const rows = await runQuery(
    `select queue_name,
            queue_length,
            newest_msg_age_sec,
            oldest_msg_age_sec,
            total_messages,
            scrape_time::text as scrape_time
       from pgmq.metrics(${quoteLiteral(queueName)})`,
  );
  return rows.length > 0 ? toMetrics(rows[0]) : null;
}

export interface PgmqMessage {
  msgId: number;
  readCount: number;
  enqueuedAt: string | null;
  vt: string | null;
  message: unknown;
}

function toMessage(r: Record<string, unknown>): PgmqMessage {
  return {
    msgId: Number(r.msg_id),
    readCount: Number(r.read_ct ?? 0),
    enqueuedAt: (r.enqueued_at as string | null) ?? null,
    vt: (r.vt as string | null) ?? null,
    message: r.message ?? null,
  };
}

/**
 * Validate + existence-check a queue name and return the quoted backing table
 * (`pgmq.q_<name>` or `pgmq.a_<name>`). This is the ONLY place a queue name
 * becomes part of an identifier, so it is gated hardest.
 */
async function backingTable(
  op: string,
  queueName: string,
  prefix: "q_" | "a_",
): Promise<string> {
  if (!isValidIdentifier(queueName)) fail(op, `invalid queue name: ${queueName}`);
  await assertQueueExists(op, queueName);
  return `pgmq.${quoteIdent(`${prefix}${queueName}`)}`;
}

async function assertQueueExists(op: string, queueName: string): Promise<void> {
  if (typeof queueName !== "string" || queueName.length === 0) {
    fail(op, "queue name is required");
  }
  const rows = await runQuery(
    `select exists(
       select 1 from pgmq.list_queues() where queue_name = ${quoteLiteral(queueName)}
     ) as found`,
  );
  if (rows[0]?.found !== true) fail(op, `queue not found: ${queueName}`);
}

/**
 * Peek live messages WITHOUT consuming them (reads the backing table directly,
 * so visibility timeouts are untouched). Oldest first.
 */
export async function peekMessages(
  queueName: string,
  limit?: number,
): Promise<PgmqMessage[]> {
  const table = await backingTable("peek", queueName, "q_");
  const n = clampLimit(limit, DEFAULT_PEEK_LIMIT, MAX_PEEK_LIMIT);
  const rows = await runQuery(
    `select msg_id,
            read_ct,
            enqueued_at::text as enqueued_at,
            vt::text as vt,
            message
       from ${table}
      order by msg_id
      limit ${n}`,
  );
  return rows.map(toMessage);
}

/** Read archived messages (`pgmq.a_<queue>`), newest first. */
export async function listArchived(
  queueName: string,
  limit?: number,
): Promise<PgmqMessage[]> {
  const table = await backingTable("archived", queueName, "a_");
  const n = clampLimit(limit, DEFAULT_PEEK_LIMIT, MAX_PEEK_LIMIT);
  const rows = await runQuery(
    `select msg_id,
            read_ct,
            enqueued_at::text as enqueued_at,
            null::text as vt,
            message
       from ${table}
      order by msg_id desc
      limit ${n}`,
  );
  return rows.map(toMessage);
}

/**
 * Accurate row count of a queue's archive table (`pgmq.a_<queue>`). The name is
 * validated against the regex allow-list AND existence-checked against the live
 * queue set before it is quote_ident'd — the same gate `backingTable` applies
 * to peek/archive reads. `pgmq.metrics(...).total_messages` counts lifetime
 * enqueues, not the archive; this is the number the archive tab shows.
 */
export async function archivedCount(queueName: string): Promise<number> {
  const table = await backingTable("archived-count", queueName, "a_");
  const rows = await runQuery(`select count(*)::int8 as n from ${table}`);
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * Send one message via `pgmq_public.send`. The body is serialized to JSON and
 * passed as a `quote_literal` cast to `jsonb`. Returns the new message id.
 */
export async function sendMessage(
  queueName: string,
  message: unknown,
): Promise<number> {
  await assertQueueExists("send", queueName);
  let json: string;
  try {
    json = JSON.stringify(message ?? null);
  } catch {
    fail("send", "message is not JSON-serializable");
  }
  const rows = await runQuery(
    `select msg_id
       from pgmq_public.send(${quoteLiteral(queueName)}, ${quoteLiteral(json)}::jsonb) as msg_id`,
  );
  const id = rows[0]?.msg_id;
  if (id == null) fail("send", "pgmq did not return a message id");
  return Number(id);
}

/** Pop (read + delete) the next visible message, or null when empty. */
export async function popMessage(queueName: string): Promise<PgmqMessage | null> {
  await assertQueueExists("pop", queueName);
  const rows = await runQuery(
    `select msg_id,
            read_ct,
            enqueued_at::text as enqueued_at,
            vt::text as vt,
            message
       from pgmq_public.pop(${quoteLiteral(queueName)})`,
  );
  return rows.length > 0 ? toMessage(rows[0]) : null;
}

/** Archive one message (moves it to `pgmq.a_<queue>`). */
export async function archiveMessage(
  queueName: string,
  msgId: number,
): Promise<boolean> {
  const id = assertSafeInteger(msgId, "message id");
  await assertQueueExists("archive", queueName);
  const rows = await runQuery(
    `select pgmq_public.archive(${quoteLiteral(queueName)}, ${id}) as ok`,
  );
  return rows[0]?.ok === true;
}

/** Permanently delete one message from the queue. */
export async function deleteMessage(
  queueName: string,
  msgId: number,
): Promise<boolean> {
  const id = assertSafeInteger(msgId, "message id");
  await assertQueueExists("delete", queueName);
  const rows = await runQuery(
    `select pgmq_public.delete(${quoteLiteral(queueName)}, ${id}) as ok`,
  );
  return rows[0]?.ok === true;
}
