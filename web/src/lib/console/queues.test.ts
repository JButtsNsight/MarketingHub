// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn() }));

vi.mock("./pgmeta", () => ({ runQuery: h.runQuery }));

import {
  archiveMessage,
  archivedCount,
  deleteMessage,
  listQueues,
  peekMessages,
  popMessage,
  queueMetrics,
  sendMessage,
} from "./queues";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

/** The next runQuery resolves as an existing queue (the existence probe). */
function queueFound() {
  h.runQuery.mockResolvedValueOnce([{ found: true }]);
}

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("readers", () => {
  test("listQueues maps the pgmq.list_queues shape", async () => {
    h.runQuery.mockResolvedValue([
      { queue_name: "jobs", is_partitioned: false, is_unlogged: false, created_at: "2026-08-07" },
    ]);
    const queues = await listQueues();
    expect(queues[0]).toEqual({
      name: "jobs",
      isPartitioned: false,
      isUnlogged: false,
      createdAt: "2026-08-07",
    });
  });

  test("queueMetrics existence-checks, then reads metrics for the literal name", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([
      {
        queue_name: "jobs",
        queue_length: 4,
        newest_msg_age_sec: 1,
        oldest_msg_age_sec: 90,
        total_messages: 120,
        scrape_time: "2026-08-07T00:00:00Z",
      },
    ]);
    const m = await queueMetrics("jobs");
    expect(m).toMatchObject({ queueName: "jobs", queueLength: 4, totalMessages: 120 });
    expect(lastSql()).toContain("pgmq.metrics('jobs')");
  });
});

describe("peekMessages (non-destructive)", () => {
  test("reads the quoted backing table after validating existence", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([
      { msg_id: 1, read_ct: 0, enqueued_at: "t", vt: "t2", message: { a: 1 } },
    ]);
    const msgs = await peekMessages("jobs", 10);
    expect(msgs[0]).toEqual({
      msgId: 1,
      readCount: 0,
      enqueuedAt: "t",
      vt: "t2",
      message: { a: 1 },
    });
    const sql = lastSql();
    expect(sql).toContain('from pgmq."q_jobs"');
    expect(sql).toContain("limit 10");
  });

  test("rejects an unsafe queue name before any SQL runs", async () => {
    await expect(peekMessages("jobs; drop table x")).rejects.toThrow(
      /\[console:queues\] peek failed: invalid queue name/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("mutations via pgmq_public", () => {
  test("sendMessage JSON-encodes and quote_literals the body", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([{ msg_id: 99 }]);
    const id = await sendMessage("jobs", { a: "x'y" });
    expect(id).toBe(99);
    expect(lastSql()).toContain(`pgmq_public.send('jobs', '{"a":"x''y"}'::jsonb)`);
  });

  test("popMessage returns null on an empty queue", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([]);
    expect(await popMessage("jobs")).toBeNull();
  });

  test("archiveMessage validates the id before touching the DB", async () => {
    await expect(archiveMessage("jobs", 2.5)).rejects.toThrow(/invalid message id/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("deleteMessage sends the boolean-returning wrapper call", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([{ ok: true }]);
    expect(await deleteMessage("jobs", 7)).toBe(true);
    expect(lastSql()).toBe("select pgmq_public.delete('jobs', 7) as ok");
  });

  test("a mutation on a missing queue fails loud", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(sendMessage("ghost", {})).rejects.toThrow(
      /\[console:queues\] send failed: queue not found/,
    );
  });
});

describe("archivedCount", () => {
  test("existence-checks then counts the archive backing table", async () => {
    queueFound();
    h.runQuery.mockResolvedValueOnce([{ n: 7 }]);
    const n = await archivedCount("jobs");
    expect(n).toBe(7);
    expect(lastSql()).toBe('select count(*)::int8 as n from pgmq."a_jobs"');
  });

  test("rejects an unsafe queue name before any SQL runs", async () => {
    await expect(archivedCount("a; drop table x")).rejects.toThrow(
      /\[console:queues\] archived-count failed: invalid queue name/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("fails loud when the queue does not exist", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(archivedCount("ghost")).rejects.toThrow(/queue not found/);
  });
});
