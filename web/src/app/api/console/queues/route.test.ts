// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

const h = vi.hoisted(() => ({
  listQueues: vi.fn(),
  allQueueMetrics: vi.fn(),
  peekMessages: vi.fn(),
  listArchived: vi.fn(),
  sendMessage: vi.fn(),
  popMessage: vi.fn(),
  archiveMessage: vi.fn(),
  deleteMessage: vi.fn(),
  runQuery: vi.fn(),
}));

vi.mock("@/lib/console/queues", () => ({
  listQueues: h.listQueues,
  allQueueMetrics: h.allQueueMetrics,
  peekMessages: h.peekMessages,
  listArchived: h.listArchived,
  sendMessage: h.sendMessage,
  popMessage: h.popMessage,
  archiveMessage: h.archiveMessage,
  deleteMessage: h.deleteMessage,
}));
// runQuery backs the archive row-count; identifiers stay REAL (under test).
vi.mock("@/lib/console/pgmeta", () => ({ runQuery: h.runQuery }));

import { DELETE, GET, PATCH, POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["mh-section-platform"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.listQueues.mockResolvedValue([
    { name: "jobs", isPartitioned: false, isUnlogged: false, createdAt: "2026-08-07" },
  ]);
  h.allQueueMetrics.mockResolvedValue([
    {
      queueName: "jobs",
      queueLength: 4,
      newestMsgAgeSec: 1,
      oldestMsgAgeSec: 90,
      totalMessages: 120,
      scrapeTime: "2026-08-07T00:00:00Z",
    },
  ]);
  h.runQuery.mockResolvedValue([{ n: 7 }]);
});

afterEach(() => {
  clearAlbEnv();
});

function auth(): HeadersInit {
  return { "x-amzn-oidc-data": platformToken };
}
function jsonAuth(): HeadersInit {
  return { "x-amzn-oidc-data": platformToken, "content-type": "application/json" };
}
const URL_BASE = "http://x/api/console/queues";

describe("GET overview", () => {
  test("401 unauthenticated", async () => {
    const res = await GET(new Request(URL_BASE));
    expect(res.status).toBe(401);
    expect(h.listQueues).not.toHaveBeenCalled();
  });

  test("403 authenticated but not in the platform section", async () => {
    const res = await GET(
      new Request(URL_BASE, { headers: { "x-amzn-oidc-data": viewersToken } }),
    );
    expect(res.status).toBe(403);
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await GET(
      new Request(URL_BASE, { headers: { "x-amzn-oidc-data": marketingToken } }),
    );
    expect(forbidden.status).toBe(403);
    expect(h.listQueues).not.toHaveBeenCalled();

    const admin = await GET(
      new Request(URL_BASE, { headers: { "x-amzn-oidc-data": adminToken } }),
    );
    expect(admin.status).toBe(200);
  });

  test("merges queues + metrics + archive count", async () => {
    const res = await GET(new Request(URL_BASE, { headers: auth() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queues: Array<Record<string, unknown>> };
    expect(body.queues).toHaveLength(1);
    expect(body.queues[0]).toMatchObject({
      name: "jobs",
      queueLength: 4,
      totalMessages: 120,
      oldestMsgAgeSec: 90,
      archiveCount: 7,
    });
    // archive count query targets the quote_ident'd backing table
    expect(String(h.runQuery.mock.calls.at(-1)?.[0])).toContain('pgmq."a_jobs"');
  });

  test("a failed archive-count query degrades that queue to null, not a 500", async () => {
    h.runQuery.mockRejectedValueOnce(new Error("relation does not exist"));
    const res = await GET(new Request(URL_BASE, { headers: auth() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queues: Array<{ archiveCount: number | null }> };
    expect(body.queues[0].archiveCount).toBeNull();
  });
});

describe("GET messages", () => {
  test("mode=live peeks (non-destructive)", async () => {
    h.peekMessages.mockResolvedValue([
      { msgId: 1, readCount: 0, enqueuedAt: "t", vt: "t2", message: { a: 1 } },
    ]);
    const res = await GET(
      new Request(`${URL_BASE}?queue=jobs&mode=live&limit=10`, { headers: auth() }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toHaveLength(1);
    expect(h.peekMessages).toHaveBeenCalledWith("jobs", 10);
    expect(h.popMessage).not.toHaveBeenCalled();
  });

  test("mode=archived returns messages + accurate count", async () => {
    h.listArchived.mockResolvedValue([
      { msgId: 9, readCount: 2, enqueuedAt: "t", vt: null, message: {} },
    ]);
    const res = await GET(
      new Request(`${URL_BASE}?queue=jobs&mode=archived`, { headers: auth() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[]; count: number };
    expect(body.messages).toHaveLength(1);
    expect(body.count).toBe(7);
  });

  test("a data-layer error maps to 400 with the stripped message", async () => {
    h.peekMessages.mockRejectedValue(
      new Error("[console:queues] peek failed: queue not found: ghost"),
    );
    const res = await GET(
      new Request(`${URL_BASE}?queue=ghost`, { headers: auth() }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "queue not found: ghost",
    );
  });
});

describe("POST send", () => {
  test("401 unauthenticated; no send", async () => {
    const res = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queue: "jobs", message: { a: 1 } }),
      }),
    );
    expect(res.status).toBe(401);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  test("201 + msgId on a valid send", async () => {
    h.sendMessage.mockResolvedValue(99);
    const res = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs", message: { a: "x" } }),
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).msgId).toBe(99);
    expect(h.sendMessage).toHaveBeenCalledWith("jobs", { a: "x" });
  });

  test("400 when queue is missing", async () => {
    const res = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: jsonAuth(),
        body: JSON.stringify({ message: { a: 1 } }),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});

describe("PATCH archive", () => {
  test("archives a message by id", async () => {
    h.archiveMessage.mockResolvedValue(true);
    const res = await PATCH(
      new Request(URL_BASE, {
        method: "PATCH",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs", msgId: 5 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).archived).toBe(true);
    expect(h.archiveMessage).toHaveBeenCalledWith("jobs", 5);
  });

  test("400 on a non-integer msgId", async () => {
    const res = await PATCH(
      new Request(URL_BASE, {
        method: "PATCH",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs", msgId: 2.5 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.archiveMessage).not.toHaveBeenCalled();
  });
});

describe("DELETE delete + pop", () => {
  test("deletes one message by id", async () => {
    h.deleteMessage.mockResolvedValue(true);
    const res = await DELETE(
      new Request(URL_BASE, {
        method: "DELETE",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs", msgId: 7 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(h.deleteMessage).toHaveBeenCalledWith("jobs", 7);
    expect(h.popMessage).not.toHaveBeenCalled();
  });

  test("pop:true pops the next visible message", async () => {
    h.popMessage.mockResolvedValue({
      msgId: 3,
      readCount: 1,
      enqueuedAt: "t",
      vt: "t2",
      message: { done: true },
    });
    const res = await DELETE(
      new Request(URL_BASE, {
        method: "DELETE",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs", pop: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).popped.msgId).toBe(3);
    expect(h.popMessage).toHaveBeenCalledWith("jobs");
    expect(h.deleteMessage).not.toHaveBeenCalled();
  });

  test("400 when neither msgId nor pop is supplied", async () => {
    const res = await DELETE(
      new Request(URL_BASE, {
        method: "DELETE",
        headers: jsonAuth(),
        body: JSON.stringify({ queue: "jobs" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.deleteMessage).not.toHaveBeenCalled();
    expect(h.popMessage).not.toHaveBeenCalled();
  });
});
