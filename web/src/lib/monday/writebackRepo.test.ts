// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  deriveOutcome,
  getRepliedRecipientIds,
  getSuppressionCreatedAt,
  listWritebackCandidates,
  markAttemptFailed,
  markSynced,
  markVerified,
  WRITEBACK_STATUSES,
  type OutcomeInputs,
} from "./writebackRepo";

/**
 * Chainable-thenable PostgREST fake, trimmed from the sms repo tests to the
 * surface this module uses (select/update, eq/in/not, order/limit). Each
 * from() opens a new query that consumes the next scripted result in call
 * order; missing results resolve `{ data: null, error: null }`.
 */
interface QueryLog {
  source: string;
  schema: string | null;
  select: string | null;
  update: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  not: Array<[string, string, unknown]>;
  order: Array<[string, unknown]>;
  limit: number | null;
}

type MockResult = { data: unknown; error: { message: string } | null };

const ok = (data: unknown): MockResult => ({ data, error: null });
const err = (message: string): MockResult => ({ data: null, error: { message } });

function buildClient(results: MockResult[] = []) {
  const queries: QueryLog[] = [];
  let next = 0;
  let currentSchema: string | null = null;

  function openQuery(source: string) {
    const log: QueryLog = {
      source,
      schema: currentSchema,
      select: null,
      update: null,
      eq: [],
      in: [],
      not: [],
      order: [],
      limit: null,
    };
    queries.push(log);
    const result = results[next++] ?? { data: null, error: null };

    const q: Record<string, unknown> = {};
    q.select = vi.fn((cols?: string) => {
      log.select = cols ?? "*";
      return q;
    });
    q.update = vi.fn((values: Record<string, unknown>) => {
      log.update = values;
      return q;
    });
    q.eq = vi.fn((column: string, value: unknown) => {
      log.eq.push([column, value]);
      return q;
    });
    q.in = vi.fn((column: string, values: unknown[]) => {
      log.in.push([column, values]);
      return q;
    });
    q.not = vi.fn((column: string, operator: string, value: unknown) => {
      log.not.push([column, operator, value]);
      return q;
    });
    q.order = vi.fn((column: string, options?: unknown) => {
      log.order.push([column, options]);
      return q;
    });
    q.limit = vi.fn((count: number) => {
      log.limit = count;
      return q;
    });
    q.then = (
      onFulfilled?: (value: MockResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected);
    return q;
  }

  const client = {
    schema: vi.fn((name: string) => {
      currentSchema = name;
      return client;
    }),
    from: vi.fn((table: string) => openQuery(table)),
  };
  return { client, queries };
}

function useClient(results: MockResult[] = []) {
  const built = buildClient(results);
  h.client = built.client;
  return built;
}

beforeEach(() => {
  h.client = null;
});

// ---------------------------------------------------------------------------
// listWritebackCandidates
// ---------------------------------------------------------------------------

const CAMPAIGN_A = {
  id: "camp-a",
  contact_list_id: "list-a",
  monday_board_id: "1111",
  send_at: "2026-08-11T15:30:00+00:00",
};
const CAMPAIGN_B = {
  id: "camp-b",
  contact_list_id: "list-b",
  monday_board_id: "2222",
  send_at: "2026-08-10T15:30:00+00:00",
};

function recipientRow(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    campaign_id: "camp-a",
    monday_item_id: "999",
    phone_e164: "+15555550100",
    status: "delivered",
    updated_at: "2026-08-11T16:00:00+00:00",
    monday_synced_at: null,
    monday_synced_status: null,
    ...over,
  };
}

describe("listWritebackCandidates", () => {
  test("joins board campaigns × configured lists × outcome-bearing rows, with the exclusion filters SQL-side", async () => {
    const { queries } = useClient([
      ok([CAMPAIGN_A, CAMPAIGN_B]),
      // Only list-a has an outcome column configured (the not-null filter
      // dropped list-b) — campaign-b contributes no candidates.
      ok([{ id: "list-a", monday_outcome_column_id: "text_col" }]),
      ok([recipientRow()]),
    ]);

    const candidates = await listWritebackCandidates(25);

    expect(queries).toHaveLength(3);
    const [campaignsQ, listsQ, recipientsQ] = queries;

    // CSV campaigns (null board) and legacy pre-lists campaigns are
    // excluded in the campaigns query itself.
    expect(campaignsQ.source).toBe("sms_campaigns");
    expect(campaignsQ.schema).toBe("marketinghub");
    expect(campaignsQ.not).toEqual([
      ["monday_board_id", "is", null],
      ["contact_list_id", "is", null],
    ]);

    expect(listsQ.source).toBe("contact_lists");
    expect(listsQ.in).toEqual([["id", ["list-a", "list-b"]]]);
    expect(listsQ.not).toEqual([["monday_outcome_column_id", "is", null]]);

    expect(recipientsQ.source).toBe("sms_campaign_recipients");
    expect(recipientsQ.in).toEqual([
      ["campaign_id", ["camp-a"]],
      ["status", WRITEBACK_STATUSES],
    ]);
    expect(recipientsQ.not).toEqual([["monday_item_id", "is", null]]);
    expect(recipientsQ.order).toEqual([
      ["monday_synced_at", { ascending: true, nullsFirst: true }],
      ["updated_at", { ascending: true }],
    ]);
    expect(recipientsQ.limit).toBe(25);

    expect(candidates).toEqual([
      {
        id: "r-1",
        campaignId: "camp-a",
        mondayItemId: "999",
        phoneE164: "+15555550100",
        status: "delivered",
        updatedAt: "2026-08-11T16:00:00+00:00",
        mondaySyncedAt: null,
        mondaySyncedStatus: null,
        boardId: "1111",
        outcomeColumnId: "text_col",
        campaignSendAt: "2026-08-11T15:30:00+00:00",
      },
    ]);
  });

  test("no board-linked campaigns → [] after one query", async () => {
    const { queries } = useClient([ok([])]);
    await expect(listWritebackCandidates(25)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
  });

  test("no list has an outcome column → [] without a recipients query", async () => {
    const { queries } = useClient([ok([CAMPAIGN_A]), ok([])]);
    await expect(listWritebackCandidates(25)).resolves.toEqual([]);
    expect(queries).toHaveLength(2);
  });

  test("merged rows re-sort never-synced first then oldest, and re-slice to the limit", async () => {
    useClient([
      ok([CAMPAIGN_A]),
      ok([{ id: "list-a", monday_outcome_column_id: "text_col" }]),
      // Deliberately unsorted: the app-side comparator must not trust
      // chunk-local SQL ordering.
      ok([
        recipientRow({
          id: "r-old-sync",
          monday_synced_at: "2026-08-10T00:00:00+00:00",
          monday_synced_status: "sent 2026-08-09",
        }),
        recipientRow({ id: "r-never-2", updated_at: "2026-08-11T17:00:00+00:00" }),
        recipientRow({ id: "r-never-1", updated_at: "2026-08-11T16:00:00+00:00" }),
        recipientRow({
          id: "r-new-sync",
          monday_synced_at: "2026-08-11T00:00:00+00:00",
          monday_synced_status: "sent 2026-08-10",
        }),
      ]),
    ]);

    const candidates = await listWritebackCandidates(3);

    expect(candidates.map((c) => c.id)).toEqual([
      "r-never-1",
      "r-never-2",
      "r-old-sync",
    ]);
  });

  test("fails loud on a PostgREST error", async () => {
    useClient([err("connection refused")]);
    await expect(listWritebackCandidates(25)).rejects.toThrow(
      "[monday-writeback] list-board-campaigns failed: connection refused",
    );
  });
});

// ---------------------------------------------------------------------------
// Enrichment lookups
// ---------------------------------------------------------------------------

describe("getRepliedRecipientIds", () => {
  test("collects matched ids, chunking the .in() filter at 200", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `r-${i}`);
    const { queries } = useClient([
      ok([{ matched_recipient_id: "r-1" }, { matched_recipient_id: null }]),
      ok([{ matched_recipient_id: "r-249" }]),
    ]);

    const replied = await getRepliedRecipientIds(ids);

    expect(queries).toHaveLength(2);
    expect(queries[0].source).toBe("sms_inbound_messages");
    expect(queries[0].in[0][1]).toHaveLength(200);
    expect(queries[1].in[0][1]).toHaveLength(50);
    expect(replied).toEqual(new Set(["r-1", "r-249"]));
  });
});

describe("getSuppressionCreatedAt", () => {
  test("maps phone → created_at over unique non-null phones", async () => {
    const { queries } = useClient([
      ok([{ phone_e164: "+15555550100", created_at: "2026-08-11T18:00:00+00:00" }]),
    ]);

    const map = await getSuppressionCreatedAt([
      "+15555550100",
      "+15555550100",
      null,
      "+15555550101",
    ]);

    expect(queries).toHaveLength(1);
    expect(queries[0].source).toBe("sms_suppressions");
    expect(queries[0].in).toEqual([
      ["phone_e164", ["+15555550100", "+15555550101"]],
    ]);
    expect(map).toEqual(
      new Map([["+15555550100", "2026-08-11T18:00:00+00:00"]]),
    );
  });

  test("all-null phones → empty map with zero queries", async () => {
    const { queries } = useClient();
    await expect(getSuppressionCreatedAt([null, null])).resolves.toEqual(
      new Map(),
    );
    expect(queries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deriveOutcome — the one documented value convention
// ---------------------------------------------------------------------------

function outcomeInputs(over: Partial<OutcomeInputs> = {}): OutcomeInputs {
  return {
    status: "delivered",
    updatedAt: "2026-08-11T16:00:00+00:00",
    campaignSendAt: "2026-08-11T15:30:00+00:00",
    replied: false,
    suppressedAt: null,
    ...over,
  };
}

describe("deriveOutcome", () => {
  test("status mapping: dated for messaged statuses, plain otherwise", () => {
    expect(deriveOutcome(outcomeInputs({ status: "sent" }))).toBe(
      "sent 2026-08-11",
    );
    expect(deriveOutcome(outcomeInputs({ status: "delivered" }))).toBe(
      "delivered 2026-08-11",
    );
    expect(deriveOutcome(outcomeInputs({ status: "undelivered" }))).toBe(
      "undelivered 2026-08-11",
    );
    expect(deriveOutcome(outcomeInputs({ status: "failed" }))).toBe("failed");
    expect(deriveOutcome(outcomeInputs({ status: "frequency_capped" }))).toBe(
      "frequency capped",
    );
    expect(deriveOutcome(outcomeInputs({ status: "suppressed" }))).toBe(
      "suppressed",
    );
    expect(deriveOutcome(outcomeInputs({ status: "skipped" }))).toBe("skipped");
    expect(deriveOutcome(outcomeInputs({ status: "canceled" }))).toBe(
      "canceled",
    );
  });

  test("replied enriches messaged rows only — a human-settled failed row stays failed", () => {
    expect(deriveOutcome(outcomeInputs({ replied: true }))).toBe("replied");
    expect(
      deriveOutcome(outcomeInputs({ status: "failed", replied: true })),
    ).toBe("failed");
  });

  test("opted out: STOP at/after the campaign send_at on a messaged row, and it outranks replied", () => {
    expect(
      deriveOutcome(
        outcomeInputs({
          replied: true,
          suppressedAt: "2026-08-11T18:00:00+00:00",
        }),
      ),
    ).toBe("opted out");
    // Boundary: exactly send_at counts (the view's >= rule).
    expect(
      deriveOutcome(outcomeInputs({ suppressedAt: "2026-08-11T15:30:00+00:00" })),
    ).toBe("opted out");
  });

  test("a STOP that predates the send is NOT this campaign's opt-out", () => {
    expect(
      deriveOutcome(outcomeInputs({ suppressedAt: "2026-08-01T00:00:00+00:00" })),
    ).toBe("delivered 2026-08-11");
  });

  test("suppression never enriches non-messaged rows (pre-send 'suppressed' stays distinct)", () => {
    expect(
      deriveOutcome(
        outcomeInputs({
          status: "suppressed",
          suppressedAt: "2026-08-11T18:00:00+00:00",
        }),
      ),
    ).toBe("suppressed");
  });

  test("determinism: identical inputs always derive the identical string", () => {
    const inputs = outcomeInputs({ status: "sent" });
    expect(deriveOutcome(inputs)).toBe(deriveOutcome(outcomeInputs({ status: "sent" })));
  });
});

// ---------------------------------------------------------------------------
// Watermark writes
// ---------------------------------------------------------------------------

describe("markSynced", () => {
  test("writes EXACTLY the two watermark columns — no status guard, no updated_at stamp", async () => {
    const { queries } = useClient([ok(null)]);

    await markSynced("r-1", "delivered 2026-08-11", new Date("2026-08-11T19:00:00Z"));

    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.source).toBe("sms_campaign_recipients");
    // The exact payload matters: an updated_at stamp would corrupt reply/
    // delivery-report attribution ordering and shift the derived dates; a
    // status guard would let the watermark lie about what Monday holds.
    expect(q.update).toEqual({
      monday_synced_at: "2026-08-11T19:00:00.000Z",
      monday_synced_status: "delivered 2026-08-11",
    });
    expect(q.eq).toEqual([["id", "r-1"]]);
    expect(q.in).toEqual([]);
  });

  test("fails loud on a PostgREST error", async () => {
    useClient([err("boom")]);
    await expect(
      markSynced("r-1", "failed", new Date("2026-08-11T19:00:00Z")),
    ).rejects.toThrow("[monday-writeback] mark-synced failed: boom");
  });
});

describe("markVerified", () => {
  test("bumps monday_synced_at ONLY, chunked at 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `r-${i}`);
    const { queries } = useClient([ok(null), ok(null)]);

    await markVerified(ids, new Date("2026-08-11T19:00:00Z"));

    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.update).toEqual({ monday_synced_at: "2026-08-11T19:00:00.000Z" });
    }
    expect(queries[0].in[0][1]).toHaveLength(200);
    expect(queries[1].in[0][1]).toHaveLength(1);
  });

  test("fails loud on a PostgREST error", async () => {
    useClient([err("boom")]);
    await expect(
      markVerified(["r-1"], new Date("2026-08-11T19:00:00Z")),
    ).rejects.toThrow("[monday-writeback] mark-verified failed: boom");
  });
});

describe("markAttemptFailed", () => {
  test("bumps monday_synced_at ONLY — the snapshot stays untouched so the row remains a candidate", async () => {
    const { queries } = useClient([ok(null)]);

    await markAttemptFailed("r-1", new Date("2026-08-11T19:00:00Z"));

    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.source).toBe("sms_campaign_recipients");
    // Requeue-to-back is the whole point: monday_synced_status untouched
    // (outcome still differs → retries next cycle), no updated_at stamp.
    expect(q.update).toEqual({ monday_synced_at: "2026-08-11T19:00:00.000Z" });
    expect(q.eq).toEqual([["id", "r-1"]]);
  });

  test("fails loud on a PostgREST error", async () => {
    useClient([err("boom")]);
    await expect(
      markAttemptFailed("r-1", new Date("2026-08-11T19:00:00Z")),
    ).rejects.toThrow("[monday-writeback] mark-attempt-failed failed: boom");
  });
});
