import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  applyDeliveryReport,
  cancelCampaign,
  claimDueRecipients,
  completeDrainedCampaigns,
  createCampaign,
  findRecipientForDeliveryReport,
  getCampaign,
  getCampaignCounts,
  getCampaignRecipients,
  getCampaignStatuses,
  getSuppressedSet,
  isSuppressed,
  listCampaignsWithCounts,
  markAmbiguous,
  markFailed,
  markRecipientFailed,
  markRetry,
  markSending,
  markSent,
  pauseCampaign,
  prepareRecipients,
  promoteDueCampaigns,
  recordSuppression,
  recordWebhookEvent,
  releaseClaim,
  releaseForConfigError,
  resumeCampaign,
  retryRecipient,
  suppressActiveRecipientsByPhone,
  type MondayRecipientRow,
} from "./repo";

/**
 * One PostgREST query chain (from() or rpc()) with everything the repo said
 * to it. The stub extends the templates-repo chainable-thenable mock with
 * rpc / in / upsert / lte / limit and a SEQUENCE of results — sms repo fns
 * issue several queries per call (e.g. create = 1 insert + N chunk inserts).
 */
interface QueryLog {
  /** Table name for from(), `rpc:<fn>` for rpc(). */
  source: string;
  rpcArgs: unknown;
  schema: string | null;
  select: string | null;
  insert: unknown;
  update: Record<string, unknown> | null;
  upsert: { row: unknown; options: unknown } | null;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  is: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
  order: Array<[string, unknown]>;
  limit: number | null;
  single: boolean;
  maybeSingle: boolean;
}

type MockResult = { data: unknown; error: { message: string } | null };

const ok = (data: unknown): MockResult => ({ data, error: null });
const err = (message: string): MockResult => ({
  data: null,
  error: { message },
});

/**
 * Chainable-thenable mock Supabase client. Each from()/rpc() opens a new
 * query that consumes the next result in `results` (queries resolve in call
 * order because the repo awaits sequentially); missing results resolve to
 * `{ data: null, error: null }`.
 */
function buildClient(results: MockResult[] = []) {
  const queries: QueryLog[] = [];
  let next = 0;
  let currentSchema: string | null = null;

  function openQuery(source: string, rpcArgs: unknown = null) {
    const log: QueryLog = {
      source,
      rpcArgs,
      schema: currentSchema,
      select: null,
      insert: null,
      update: null,
      upsert: null,
      eq: [],
      in: [],
      is: [],
      lte: [],
      order: [],
      limit: null,
      single: false,
      maybeSingle: false,
    };
    queries.push(log);
    const result = results[next++] ?? { data: null, error: null };

    const q: Record<string, unknown> = {};
    q.select = vi.fn((cols?: string) => {
      log.select = cols ?? "*";
      return q;
    });
    q.insert = vi.fn((rows: unknown) => {
      log.insert = rows;
      return q;
    });
    q.update = vi.fn((row: Record<string, unknown>) => {
      log.update = row;
      return q;
    });
    q.upsert = vi.fn((row: unknown, options: unknown) => {
      log.upsert = { row, options };
      return q;
    });
    q.eq = vi.fn((col: string, val: unknown) => {
      log.eq.push([col, val]);
      return q;
    });
    q.in = vi.fn((col: string, vals: unknown[]) => {
      log.in.push([col, vals]);
      return q;
    });
    q.is = vi.fn((col: string, val: unknown) => {
      log.is.push([col, val]);
      return q;
    });
    q.lte = vi.fn((col: string, val: unknown) => {
      log.lte.push([col, val]);
      return q;
    });
    q.order = vi.fn((col: string, opts: unknown) => {
      log.order.push([col, opts]);
      return q;
    });
    q.limit = vi.fn((n: number) => {
      log.limit = n;
      return q;
    });
    q.single = vi.fn(() => {
      log.single = true;
      return Promise.resolve(result);
    });
    q.maybeSingle = vi.fn(() => {
      log.maybeSingle = true;
      return Promise.resolve(result);
    });
    // thenable so `await query` resolves to the assigned result
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return q;
  }

  const from = vi.fn((table: string) => openQuery(table));
  const rpc = vi.fn((fn: string, args?: unknown) =>
    openQuery(`rpc:${fn}`, args ?? null),
  );
  const schema = vi.fn((s: string) => {
    currentSchema = s;
    return { from, rpc };
  });
  return { client: { schema }, queries };
}

function mondayRow(over: Partial<MondayRecipientRow> = {}): MondayRecipientRow {
  return {
    mondayItemId: "m1",
    name: "Jane Doe",
    firstName: "Jane",
    phoneE164: "+15551230001",
    rawPhone: "(555) 123-0001",
    ...over,
  };
}

const campaignRow = {
  id: "c1",
  name: "August outreach",
  template_id: "3b9f8a52-6a1e-4c85-9d5e-2f6f6f6f6f6f",
  monday_board_id: "12345",
  monday_phone_column_id: "phone",
  message_body: "Hi {{firstName}}",
  send_date: "2026-08-05",
  send_at: "2026-08-05T15:30:00.000Z",
  status: "scheduled",
  created_by: "amy@nsight.example",
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
};

const recipientRow = {
  id: "r1",
  campaign_id: "c1",
  monday_item_id: "m1",
  name: "Jane Doe",
  first_name: "Jane",
  phone_e164: "+15551230001",
  rendered_text: "Hi Jane",
  status: "pending",
  attempts: 0,
  send_after: "2026-08-05T15:30:00.000Z",
  claimed_at: null,
  claim_expires_at: null,
  st_message_id: null,
  st_credits: null,
  last_error: null,
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
};

/** send_after / updated_at style timestamps stamped "now" by the repo. */
function expectRecentIso(value: unknown) {
  expect(typeof value).toBe("string");
  expect(Math.abs(Date.parse(value as string) - Date.now())).toBeLessThan(
    10_000,
  );
}

const validInput = {
  name: "August outreach",
  templateId: "3b9f8a52-6a1e-4c85-9d5e-2f6f6f6f6f6f",
  mondayBoardId: "12345",
  mondayPhoneColumnId: "phone",
  sendDate: "2026-08-05",
};

const user = { email: "amy@nsight.example" };

beforeEach(() => {
  h.client = null;
});

// ---------------------------------------------------------------------------
// prepareRecipients — pure creation-time classification
// ---------------------------------------------------------------------------
describe("prepareRecipients", () => {
  test("valid unique phone becomes pending with rendered_text merged per recipient", () => {
    const rows = prepareRecipients(
      [
        mondayRow(),
        mondayRow({
          mondayItemId: "m2",
          name: "Bob Roe",
          firstName: "Bob",
          phoneE164: "+15551230002",
          rawPhone: "555-123-0002",
        }),
      ],
      "Hi {{firstName}}, this is {{ name }} day",
      new Set(),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      monday_item_id: "m1",
      name: "Jane Doe",
      first_name: "Jane",
      phone_e164: "+15551230001",
      status: "pending",
      last_error: null,
    });
    expect(rows[0].rendered_text).toBe("Hi Jane, this is Jane Doe day");
    expect(rows[1].rendered_text).toBe("Hi Bob, this is Bob Roe day");
  });

  test("null phone → skipped with phone_e164 null and raw phone noted in last_error", () => {
    const rows = prepareRecipients(
      [mondayRow({ phoneE164: null, rawPhone: "not-a-phone" })],
      "Hi {{firstName}}",
      new Set(),
    );

    expect(rows[0].status).toBe("skipped");
    expect(rows[0].phone_e164).toBeNull();
    expect(rows[0].last_error).toContain("not-a-phone");
  });

  test("duplicate phone keeps the FIRST row; dupes are skipped with phone_e164 NULL (unique constraint) and the raw phone in last_error", () => {
    const rows = prepareRecipients(
      [
        mondayRow({ mondayItemId: "m1" }),
        mondayRow({ mondayItemId: "m2", rawPhone: "555.123.0001" }),
        mondayRow({ mondayItemId: "m3" }),
      ],
      "Hi {{firstName}}",
      new Set(),
    );

    expect(rows[0].status).toBe("pending");
    expect(rows[0].phone_e164).toBe("+15551230001");
    // Both duplicates: unique(campaign_id, phone_e164) — nulls are distinct,
    // so skipped dupes MUST carry phone_e164 = null or the insert would blow.
    for (const dupe of [rows[1], rows[2]]) {
      expect(dupe.status).toBe("skipped");
      expect(dupe.phone_e164).toBeNull();
      expect(dupe.last_error).toMatch(/duplicate/i);
    }
    expect(rows[1].last_error).toContain("555.123.0001");
  });

  test("phone on the suppression set → suppressed (phone kept for audit)", () => {
    const rows = prepareRecipients(
      [mondayRow()],
      "Hi {{firstName}}",
      new Set(["+15551230001"]),
    );

    expect(rows[0].status).toBe("suppressed");
    expect(rows[0].phone_e164).toBe("+15551230001");
  });

  test("duplicate of a suppressed phone is still deduped to skipped/null", () => {
    const rows = prepareRecipients(
      [mondayRow({ mondayItemId: "m1" }), mondayRow({ mondayItemId: "m2" })],
      "Hi {{firstName}}",
      new Set(["+15551230001"]),
    );

    expect(rows[0].status).toBe("suppressed");
    expect(rows[1].status).toBe("skipped");
    expect(rows[1].phone_e164).toBeNull();
  });

  test("first_name falls back to firstNameOf(name) when firstName is blank", () => {
    const rows = prepareRecipients(
      [mondayRow({ firstName: "" })],
      "Hi {{firstName}}",
      new Set(),
    );
    expect(rows[0].first_name).toBe("Jane");
    expect(rows[0].rendered_text).toBe("Hi Jane");
  });
});

// ---------------------------------------------------------------------------
// getSuppressedSet — chunked .in() lookups on sms_suppressions
// ---------------------------------------------------------------------------
describe("getSuppressedSet", () => {
  test("chunks phones 200 per .in() query and unions the hits", async () => {
    const phones: Array<string | null> = [];
    for (let i = 0; i < 250; i++) {
      phones.push(`+1555${String(1000000 + i)}`);
    }
    phones.push(null); // dropped
    phones.push(phones[0]); // deduped

    const { client, queries } = buildClient([
      ok([{ phone_e164: "+15551000003" }]),
      ok([{ phone_e164: "+15551000249" }]),
    ]);
    h.client = client;

    const set = await getSuppressedSet(phones);

    expect(queries).toHaveLength(2);
    expect(queries[0].schema).toBe("marketinghub");
    expect(queries[0].source).toBe("sms_suppressions");
    expect(queries[0].in[0][0]).toBe("phone_e164");
    expect(queries[0].in[0][1]).toHaveLength(200);
    expect(queries[1].in[0][1]).toHaveLength(50);
    expect(set).toEqual(new Set(["+15551000003", "+15551000249"]));
  });

  test("no usable phones → empty set with zero queries", async () => {
    const { client, queries } = buildClient();
    h.client = client;
    expect(await getSuppressedSet([null, null])).toEqual(new Set());
    expect(queries).toHaveLength(0);
  });

  test("fails loud with the [sms] prefix on a PostgREST error", async () => {
    const { client } = buildClient([err("db down")]);
    h.client = client;
    await expect(getSuppressedSet(["+15551230001"])).rejects.toThrow(
      /\[sms\].*db down/,
    );
  });
});

// ---------------------------------------------------------------------------
// createCampaign — snapshot row + 200-row chunked recipient inserts
// ---------------------------------------------------------------------------
describe("createCampaign", () => {
  function prepared(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      monday_item_id: `m${i}`,
      name: `Person ${i}`,
      first_name: "Person",
      phone_e164: `+1555${String(2000000 + i)}`,
      rendered_text: `Hi Person ${i}`,
      status: "pending" as const,
      last_error: null,
    }));
  }

  test("inserts the campaign snapshot (message_body, DST-aware send_at, scheduled, created_by) then chunk-inserts recipients 200 at a time", async () => {
    const { client, queries } = buildClient([
      ok(campaignRow),
      ok(null),
      ok(null),
      ok(null),
    ]);
    h.client = client;

    const created = await createCampaign(
      validInput,
      "Hi {{firstName}}",
      prepared(450),
      user,
    );

    expect(created.id).toBe("c1");
    expect(queries[0].schema).toBe("marketinghub");
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].insert).toMatchObject({
      name: "August outreach",
      template_id: validInput.templateId,
      monday_board_id: "12345",
      monday_phone_column_id: "phone",
      message_body: "Hi {{firstName}}",
      send_date: "2026-08-05",
      // 2026-08-05 is EDT: 11:30 America/New_York === 15:30Z
      send_at: "2026-08-05T15:30:00.000Z",
      status: "scheduled",
      created_by: "amy@nsight.example",
    });
    expect(queries[0].single).toBe(true);

    // 450 recipients → 3 chunks of 200/200/50 into sms_campaign_recipients
    expect(queries).toHaveLength(4);
    const chunks = queries.slice(1);
    expect(chunks.map((q) => q.source)).toEqual([
      "sms_campaign_recipients",
      "sms_campaign_recipients",
      "sms_campaign_recipients",
    ]);
    expect(chunks.map((q) => (q.insert as unknown[]).length)).toEqual([
      200, 200, 50,
    ]);
    const firstRow = (chunks[0].insert as Record<string, unknown>[])[0];
    expect(firstRow.campaign_id).toBe("c1");
    expect(firstRow.send_after).toBe("2026-08-05T15:30:00.000Z");
    expect(firstRow.status).toBe("pending");
    expect(firstRow.rendered_text).toBe("Hi Person 0");
  });

  test("accepts a pasted Monday board URL (schema transform reduces it to the id)", async () => {
    const { client, queries } = buildClient([ok(campaignRow), ok(null)]);
    h.client = client;

    await createCampaign(
      {
        ...validInput,
        mondayBoardId: "https://acme.monday.com/boards/998877/views/1",
      },
      "Hi {{firstName}}",
      prepared(1),
      user,
    );

    expect(
      (queries[0].insert as Record<string, unknown>).monday_board_id,
    ).toBe("998877");
  });

  test("chunk-insert failure best-effort cancels the campaign, then fails loud", async () => {
    const { client, queries } = buildClient([
      ok(campaignRow),
      err("unique violation"),
      ok(null), // best-effort cancel update
    ]);
    h.client = client;

    await expect(
      createCampaign(validInput, "Hi {{firstName}}", prepared(10), user),
    ).rejects.toThrow(/\[sms\].*unique violation/);

    const cancel = queries[2];
    expect(cancel.source).toBe("sms_campaigns");
    expect(cancel.update?.status).toBe("canceled");
    expect(cancel.eq).toContainEqual(["id", "c1"]);
  });

  test("campaign insert failure fails loud without touching recipients", async () => {
    const { client, queries } = buildClient([err("nope")]);
    h.client = client;

    await expect(
      createCampaign(validInput, "Hi {{firstName}}", prepared(3), user),
    ).rejects.toThrow(/\[sms\] create failed: nope/);
    expect(queries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
describe("reads", () => {
  test("listCampaignsWithCounts lists newest-first and merges the counts view (zero-filled)", async () => {
    const other = { ...campaignRow, id: "c2", name: "Later" };
    const { client, queries } = buildClient([
      ok([campaignRow, other]),
      ok([
        { campaign_id: "c1", status: "pending", count: 3 },
        { campaign_id: "c1", status: "skipped", count: 1 },
        { campaign_id: "c2", status: "sent", count: 7 },
      ]),
    ]);
    h.client = client;

    const list = await listCampaignsWithCounts();

    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].order).toContainEqual([
      "created_at",
      { ascending: false },
    ]);
    // counts come from the security_invoker view, scoped to the listed ids
    expect(queries[1].source).toBe("sms_campaign_recipient_counts");
    expect(queries[1].in).toContainEqual(["campaign_id", ["c1", "c2"]]);

    expect(list).toHaveLength(2);
    expect(list[0].counts.pending).toBe(3);
    expect(list[0].counts.skipped).toBe(1);
    expect(list[0].counts.sent).toBe(0); // zero-filled
    expect(list[1].counts.sent).toBe(7);
  });

  test("listCampaignsWithCounts with no campaigns returns [] without querying the view", async () => {
    const { client, queries } = buildClient([ok([])]);
    h.client = client;
    expect(await listCampaignsWithCounts()).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  test("getCampaign returns the row when found, null when missing", async () => {
    const found = buildClient([ok(campaignRow)]);
    h.client = found.client;
    const campaign = await getCampaign("c1");
    expect(found.queries[0].eq).toContainEqual(["id", "c1"]);
    expect(found.queries[0].maybeSingle).toBe(true);
    expect(campaign?.id).toBe("c1");

    const missing = buildClient([ok(null)]);
    h.client = missing.client;
    expect(await getCampaign("nope")).toBeNull();
  });

  test("getCampaignRecipients scopes to the campaign and caps at 2000", async () => {
    const { client, queries } = buildClient([ok([{ id: "r1" }])]);
    h.client = client;

    const rows = await getCampaignRecipients("c1");

    expect(queries[0].source).toBe("sms_campaign_recipients");
    expect(queries[0].eq).toContainEqual(["campaign_id", "c1"]);
    expect(queries[0].limit).toBe(2000);
    expect(queries[0].order).toContainEqual([
      "created_at",
      { ascending: true },
    ]);
    expect(rows).toHaveLength(1);
  });

  test("getCampaignCounts returns a zero-filled record for every recipient status", async () => {
    const { client, queries } = buildClient([
      ok([
        { campaign_id: "c1", status: "pending", count: 2 },
        { campaign_id: "c1", status: "failed_ambiguous", count: 1 },
      ]),
    ]);
    h.client = client;

    const counts = await getCampaignCounts("c1");

    expect(queries[0].source).toBe("sms_campaign_recipient_counts");
    expect(queries[0].eq).toContainEqual(["campaign_id", "c1"]);
    expect(counts.pending).toBe(2);
    expect(counts.failed_ambiguous).toBe(1);
    expect(counts.delivered).toBe(0);
    expect(counts.canceled).toBe(0);
  });

  test("read errors fail loud with the [sms] prefix", async () => {
    const { client } = buildClient([err("view gone")]);
    h.client = client;
    await expect(getCampaignCounts("c1")).rejects.toThrow(/\[sms\].*view gone/);
  });
});

// ---------------------------------------------------------------------------
// Conditional transitions — the .eq('status', …) guards ARE the durability
// story: row count = won/lost, null = lost the race (routes answer 409).
// ---------------------------------------------------------------------------
describe("campaign transitions", () => {
  test("pauseCampaign pauses only scheduled|sending, then releases claimed rows to pending", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
    ]);
    h.client = client;

    const paused = await pauseCampaign("c1");

    expect(paused?.status).toBe("paused");
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].update?.status).toBe("paused");
    expect(queries[0].eq).toContainEqual(["id", "c1"]);
    expect(queries[0].in).toContainEqual(["status", ["scheduled", "sending"]]);
    expect(queries[0].maybeSingle).toBe(true);

    // claimed rows are released so a resumed campaign re-claims them cleanly
    const release = queries[1];
    expect(release.source).toBe("sms_campaign_recipients");
    expect(release.update).toMatchObject({
      status: "pending",
      claimed_at: null,
      claim_expires_at: null,
    });
    expect(release.eq).toContainEqual(["campaign_id", "c1"]);
    expect(release.eq).toContainEqual(["status", "claimed"]);
  });

  test("pauseCampaign returns null (409) without touching recipients when the guard loses", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;
    expect(await pauseCampaign("c1")).toBeNull();
    expect(queries).toHaveLength(1);
  });

  test("resumeCampaign moves paused → scheduled (dispatcher promotion re-decides)", async () => {
    const { client, queries } = buildClient([ok(campaignRow)]);
    h.client = client;

    const resumed = await resumeCampaign("c1");

    expect(resumed?.id).toBe("c1");
    expect(queries[0].update?.status).toBe("scheduled");
    expect(queries[0].eq).toContainEqual(["id", "c1"]);
    expect(queries[0].eq).toContainEqual(["status", "paused"]);
  });

  test("resumeCampaign returns null when the campaign is not paused", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await resumeCampaign("c1")).toBeNull();
  });

  test("cancelCampaign cancels scheduled|sending|paused and cancels pending|claimed recipients", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "canceled" }),
      ok(null),
    ]);
    h.client = client;

    const canceled = await cancelCampaign("c1");

    expect(canceled?.status).toBe("canceled");
    expect(queries[0].update?.status).toBe("canceled");
    expect(queries[0].eq).toContainEqual(["id", "c1"]);
    expect(queries[0].in).toContainEqual([
      "status",
      ["scheduled", "sending", "paused"],
    ]);

    const sweep = queries[1];
    expect(sweep.source).toBe("sms_campaign_recipients");
    expect(sweep.update).toMatchObject({
      status: "canceled",
      claimed_at: null,
      claim_expires_at: null,
    });
    expect(sweep.eq).toContainEqual(["campaign_id", "c1"]);
    // sending rows are NOT canceled — the in-flight POST completes naturally
    expect(sweep.in).toContainEqual(["status", ["pending", "claimed"]]);
  });

  test("cancelCampaign returns null for terminal campaigns without a recipient sweep", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;
    expect(await cancelCampaign("c1")).toBeNull();
    expect(queries).toHaveLength(1);
  });

  // DELIBERATE TEST UPDATE (defect A): retryRecipient now pre-checks the
  // row's campaign status before flipping the row — the two lookup queries
  // (recipient → campaign) precede the guarded update.
  test("retryRecipient re-queues failed_ambiguous|failed with send_after=now and re-opens a completed campaign", async () => {
    const { client, queries } = buildClient([
      ok({ campaign_id: "c1" }), // recipient lookup
      ok({ status: "completed" }), // campaign status pre-check
      ok({ ...recipientRow, status: "pending" }),
      ok(null),
    ]);
    h.client = client;

    const row = await retryRecipient("r1");

    expect(row?.id).toBe("r1");
    const lookup = queries[0];
    expect(lookup.source).toBe("sms_campaign_recipients");
    expect(lookup.eq).toContainEqual(["id", "r1"]);
    const statusCheck = queries[1];
    expect(statusCheck.source).toBe("sms_campaigns");
    expect(statusCheck.eq).toContainEqual(["id", "c1"]);

    const retry = queries[2];
    expect(retry.source).toBe("sms_campaign_recipients");
    expect(retry.update).toMatchObject({
      status: "pending",
      claimed_at: null,
      claim_expires_at: null,
    });
    expectRecentIso(retry.update?.send_after);
    expect(retry.eq).toContainEqual(["id", "r1"]);
    expect(retry.in).toContainEqual(["status", ["failed_ambiguous", "failed"]]);

    // completed → sending re-open, guarded so other states are untouched
    const reopen = queries[3];
    expect(reopen.source).toBe("sms_campaigns");
    expect(reopen.update?.status).toBe("sending");
    expect(reopen.eq).toContainEqual(["id", "c1"]);
    expect(reopen.eq).toContainEqual(["status", "completed"]);
  });

  test("retryRecipient returns null (409) for a row in a CANCELED campaign without issuing any recipient update", async () => {
    const { client, queries } = buildClient([
      ok({ campaign_id: "c1" }),
      ok({ status: "canceled" }),
    ]);
    h.client = client;

    expect(await retryRecipient("r1")).toBeNull();

    // Only the two read queries ran — the row was never flipped to pending
    // (a pending row inside a canceled campaign could never dispatch NOR be
    // retried/mark_failed again: it would be wedged forever).
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.update).toBeNull();
  });

  test("retryRecipient returns null (409) for an unknown recipient id", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;
    expect(await retryRecipient("r-missing")).toBeNull();
    expect(queries).toHaveLength(1);
    expect(queries[0].update).toBeNull();
  });

  // DELIBERATE TEST UPDATE (defect A): the lost-guard case now runs the two
  // pre-check reads before the (losing) conditional update.
  test("retryRecipient returns null (409) without touching the campaign when the guard loses", async () => {
    const { client, queries } = buildClient([
      ok({ campaign_id: "c1" }),
      ok({ status: "sending" }),
      ok(null),
    ]);
    h.client = client;
    expect(await retryRecipient("r1")).toBeNull();
    expect(queries).toHaveLength(3);
  });

  test("markRecipientFailed resolves failed_ambiguous → failed only", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "failed" }),
    ]);
    h.client = client;

    const row = await markRecipientFailed("r1", "manual review: assumed lost");

    expect(row?.status).toBe("failed");
    expect(queries[0].update?.status).toBe("failed");
    expect(queries[0].update?.last_error).toBe("manual review: assumed lost");
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "failed_ambiguous"]);
  });

  test("markRecipientFailed returns null when the row is not failed_ambiguous", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await markRecipientFailed("r1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher accessors
// ---------------------------------------------------------------------------
describe("dispatcher accessors", () => {
  test("claimDueRecipients calls the claim RPC on the marketinghub schema with batch_size/claim_ttl_seconds", async () => {
    const { client, queries } = buildClient([
      ok([{ ...recipientRow, status: "claimed" }]),
    ]);
    h.client = client;

    const claimed = await claimDueRecipients(25, 180);

    expect(queries[0].schema).toBe("marketinghub");
    expect(queries[0].source).toBe("rpc:claim_due_sms_recipients");
    expect(queries[0].rpcArgs).toEqual({
      batch_size: 25,
      claim_ttl_seconds: 180,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("claimed");
  });

  test("claimDueRecipients fails loud when the RPC errors", async () => {
    const { client } = buildClient([err("function missing")]);
    h.client = client;
    await expect(claimDueRecipients(25, 180)).rejects.toThrow(
      /\[sms\].*function missing/,
    );
  });

  test("promoteDueCampaigns promotes only scheduled campaigns whose send_at is due", async () => {
    const { client, queries } = buildClient([ok([{ id: "c1" }, { id: "c2" }])]);
    h.client = client;

    const now = new Date("2026-08-05T15:31:00.000Z");
    const promoted = await promoteDueCampaigns(now);

    expect(promoted).toEqual(["c1", "c2"]);
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].update?.status).toBe("sending");
    expect(queries[0].eq).toContainEqual(["status", "scheduled"]);
    expect(queries[0].lte).toContainEqual([
      "send_at",
      "2026-08-05T15:31:00.000Z",
    ]);
  });

  test("markSending is guarded on status=claimed and writes the caller-computed attempts", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "sending", attempts: 3 }),
    ]);
    h.client = client;

    const row = await markSending("r1", 3);

    expect(row?.attempts).toBe(3);
    expect(queries[0].update).toMatchObject({ status: "sending", attempts: 3 });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    // NEVER remove this guard: attempts+1 is a read-modify-write and pause/
    // cancel releases race this update — 0 rows matched means we lost.
    expect(queries[0].eq).toContainEqual(["status", "claimed"]);
    expect(queries[0].maybeSingle).toBe(true);
  });

  test("markSending returns null when the claim was released (race lost)", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await markSending("r1", 1)).toBeNull();
  });

  test("markSent records st_message_id/st_credits, guarded on status=sending", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "sent" }),
    ]);
    h.client = client;

    const row = await markSent("r1", { stMessageId: "st-9", stCredits: 1 });

    expect(row?.status).toBe("sent");
    expect(queries[0].update).toMatchObject({
      status: "sent",
      st_message_id: "st-9",
      st_credits: 1,
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "sending"]);
  });

  test("markFailed stores the error detail, guarded on status=sending", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "failed" }),
    ]);
    h.client = client;

    await markFailed("r1", "HTTP 422: bad number");

    expect(queries[0].update).toMatchObject({
      status: "failed",
      last_error: "HTTP 422: bad number",
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "sending"]);
  });

  test("markRetry re-queues to pending with the backoff send_after, guarded on status=sending", async () => {
    const { client, queries } = buildClient([ok(recipientRow)]);
    h.client = client;

    const backoffTo = new Date("2026-08-05T15:32:00.000Z");
    await markRetry("r1", backoffTo, "HTTP 429: throttled");

    expect(queries[0].update).toMatchObject({
      status: "pending",
      send_after: "2026-08-05T15:32:00.000Z",
      last_error: "HTTP 429: throttled",
      claimed_at: null,
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "sending"]);
  });

  test("markAmbiguous parks the row as failed_ambiguous, guarded on status=sending", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "failed_ambiguous" }),
    ]);
    h.client = client;

    await markAmbiguous("r1", "TimeoutError: request timed out");

    expect(queries[0].update).toMatchObject({
      status: "failed_ambiguous",
      last_error: "TimeoutError: request timed out",
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "sending"]);
  });

  test("releaseClaim returns an un-attempted claimed row to pending", async () => {
    const { client, queries } = buildClient([ok(recipientRow)]);
    h.client = client;

    await releaseClaim("r1");

    expect(queries[0].update).toMatchObject({
      status: "pending",
      claimed_at: null,
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    // only claimed rows may be released — a row that made it to sending has
    // started a POST and must resolve through a mark* transition instead
    expect(queries[0].eq).toContainEqual(["status", "claimed"]);
  });

  test("releaseForConfigError compensates attempts and re-queues, guarded on status=sending", async () => {
    const { client, queries } = buildClient([ok(recipientRow)]);
    h.client = client;

    await releaseForConfigError("r1", 2, "HTTP 401: bad token");

    expect(queries[0].update).toMatchObject({
      status: "pending",
      attempts: 2, // caller passes back the pre-increment value
      claimed_at: null,
      claim_expires_at: null,
      last_error: "HTTP 401: bad token",
    });
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "sending"]);
  });

  test("isSuppressed checks the STOP list for one phone", async () => {
    const hit = buildClient([ok({ phone_e164: "+15551230001" })]);
    h.client = hit.client;
    expect(await isSuppressed("+15551230001")).toBe(true);
    expect(hit.queries[0].source).toBe("sms_suppressions");
    expect(hit.queries[0].eq).toContainEqual(["phone_e164", "+15551230001"]);

    const miss = buildClient([ok(null)]);
    h.client = miss.client;
    expect(await isSuppressed("+15551230002")).toBe(false);
  });

  test("getCampaignStatuses maps ids to statuses in one .in() query", async () => {
    const { client, queries } = buildClient([
      ok([
        { id: "c1", status: "sending" },
        { id: "c2", status: "paused" },
      ]),
    ]);
    h.client = client;

    const statuses = await getCampaignStatuses(["c1", "c2"]);

    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].in).toContainEqual(["id", ["c1", "c2"]]);
    expect(statuses.get("c1")).toBe("sending");
    expect(statuses.get("c2")).toBe("paused");
  });

  test("getCampaignStatuses with no ids returns an empty map without querying", async () => {
    const { client, queries } = buildClient();
    h.client = client;
    expect((await getCampaignStatuses([])).size).toBe(0);
    expect(queries).toHaveLength(0);
  });

  test("completeDrainedCampaigns completes sending campaigns with zero active rows (guarded)", async () => {
    const { client, queries } = buildClient([
      ok([{ id: "c1" }, { id: "c2" }, { id: "c3" }]),
      ok([{ campaign_id: "c2" }]), // c2 still has active rows
      ok([{ id: "c1" }, { id: "c3" }]),
    ]);
    h.client = client;

    const completed = await completeDrainedCampaigns();

    expect(completed).toEqual(["c1", "c3"]);
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].eq).toContainEqual(["status", "sending"]);

    // "active" = any row still pending|claimed|sending, via the counts view
    expect(queries[1].source).toBe("sms_campaign_recipient_counts");
    expect(queries[1].in).toContainEqual(["campaign_id", ["c1", "c2", "c3"]]);
    expect(queries[1].in).toContainEqual([
      "status",
      ["pending", "claimed", "sending"],
    ]);

    const complete = queries[2];
    expect(complete.source).toBe("sms_campaigns");
    expect(complete.update?.status).toBe("completed");
    expect(complete.in).toContainEqual(["id", ["c1", "c3"]]);
    // guarded: a retryRecipient re-open between check and update must win
    expect(complete.eq).toContainEqual(["status", "sending"]);
  });

  test("completeDrainedCampaigns is a no-op when nothing is sending or nothing drained", async () => {
    const none = buildClient([ok([])]);
    h.client = none.client;
    expect(await completeDrainedCampaigns()).toEqual([]);
    expect(none.queries).toHaveLength(1);

    const allActive = buildClient([
      ok([{ id: "c1" }]),
      ok([{ campaign_id: "c1" }]),
    ]);
    h.client = allActive.client;
    expect(await completeDrainedCampaigns()).toEqual([]);
    expect(allActive.queries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Webhook accessors — STOP suppression + delivery-report reconciliation
// ---------------------------------------------------------------------------
describe("webhook accessors", () => {
  test("recordSuppression upserts onto the phone_e164 primary key (STOP is permanent, re-STOP is a no-op)", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;

    await recordSuppression("+15551230001", "stop", { action: "STOP" });

    expect(queries[0].source).toBe("sms_suppressions");
    expect(queries[0].upsert?.row).toEqual({
      phone_e164: "+15551230001",
      reason: "stop",
      raw: { action: "STOP" },
    });
    expect(queries[0].upsert?.options).toMatchObject({
      onConflict: "phone_e164",
    });
  });

  test("recordSuppression fails loud on error", async () => {
    const { client } = buildClient([err("nope")]);
    h.client = client;
    await expect(recordSuppression("+15551230001", "manual")).rejects.toThrow(
      /\[sms\].*nope/,
    );
  });

  test("suppressActiveRecipientsByPhone suppresses pending|claimed rows across ALL campaigns and returns the count", async () => {
    const { client, queries } = buildClient([ok([{ id: "r1" }, { id: "r2" }])]);
    h.client = client;

    const n = await suppressActiveRecipientsByPhone("+15551230001");

    expect(n).toBe(2);
    expect(queries[0].source).toBe("sms_campaign_recipients");
    expect(queries[0].update).toMatchObject({
      status: "suppressed",
      claimed_at: null,
      claim_expires_at: null,
    });
    expect(queries[0].eq).toContainEqual(["phone_e164", "+15551230001"]);
    // active-only guard; NO campaign_id filter — STOP fans out everywhere
    expect(queries[0].in).toContainEqual(["status", ["pending", "claimed"]]);
    expect(queries[0].eq.map(([col]) => col)).not.toContain("campaign_id");
  });

  test("recordWebhookEvent stores the raw payload with its classification and match", async () => {
    const { client, queries } = buildClient([ok({ id: "evt-1" })]);
    h.client = client;

    const id = await recordWebhookEvent(
      "delivery_report",
      { messageId: "st-9" },
      "r1",
    );

    expect(id).toBe("evt-1");
    expect(queries[0].source).toBe("sms_webhook_events");
    expect(queries[0].insert).toEqual({
      kind: "delivery_report",
      raw: { messageId: "st-9" },
      matched_recipient_id: "r1",
    });
    expect(queries[0].single).toBe(true);
  });

  test("recordWebhookEvent defaults matched_recipient_id to null", async () => {
    const { client, queries } = buildClient([ok({ id: "evt-2" })]);
    h.client = client;
    await recordWebhookEvent("unknown", { unparsed: "???" });
    expect(
      (queries[0].insert as Record<string, unknown>).matched_recipient_id,
    ).toBeNull();
  });

  test("findRecipientForDeliveryReport matches by st_message_id first", async () => {
    const { client, queries } = buildClient([
      ok([{ ...recipientRow, status: "sent", st_message_id: "st-9" }]),
    ]);
    h.client = client;

    const row = await findRecipientForDeliveryReport({
      stMessageId: "st-9",
      phone: "+15551230001",
    });

    expect(row?.id).toBe("r1");
    expect(queries).toHaveLength(1);
    expect(queries[0].eq).toContainEqual(["st_message_id", "st-9"]);
    expect(queries[0].limit).toBe(1);
  });

  test("findRecipientForDeliveryReport falls back to the newest awaiting-outcome row by phone", async () => {
    const { client, queries } = buildClient([
      ok([]), // st_message_id miss
      ok([{ ...recipientRow, status: "failed_ambiguous" }]),
    ]);
    h.client = client;

    const row = await findRecipientForDeliveryReport({
      stMessageId: "st-9",
      phone: "+15551230001",
    });

    expect(row?.status).toBe("failed_ambiguous");
    const byPhone = queries[1];
    expect(byPhone.eq).toContainEqual(["phone_e164", "+15551230001"]);
    // only rows whose outcome a delivery report can settle
    expect(byPhone.in).toContainEqual([
      "status",
      ["sent", "sending", "failed_ambiguous"],
    ]);
    // ...and ONLY rows that never learned a message id: a 'sent' row that
    // already carries a DIFFERENT st_message_id belongs to another message
    // and must never be matched (and then corrupted) by the phone fallback.
    expect(byPhone.is).toContainEqual(["st_message_id", null]);
    expect(byPhone.order).toContainEqual(["updated_at", { ascending: false }]);
    expect(byPhone.limit).toBe(1);
  });

  test("findRecipientForDeliveryReport returns null when nothing matches", async () => {
    const { client } = buildClient([ok([]), ok([])]);
    h.client = client;
    expect(
      await findRecipientForDeliveryReport({
        stMessageId: "st-9",
        phone: "+15551230001",
      }),
    ).toBeNull();

    const noLookup = buildClient();
    h.client = noLookup.client;
    expect(await findRecipientForDeliveryReport({})).toBeNull();
    expect(noLookup.queries).toHaveLength(0);
  });

  test("applyDeliveryReport(delivered) settles sent|sending|failed_ambiguous and backfills st_message_id", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "delivered" }),
    ]);
    h.client = client;

    const row = await applyDeliveryReport("r1", {
      delivered: true,
      stMessageId: "st-9",
    });

    expect(row?.status).toBe("delivered");
    expect(queries[0].update).toMatchObject({
      status: "delivered",
      st_message_id: "st-9",
      claim_expires_at: null,
    });
    expect(queries[0].update?.last_error).toBeUndefined();
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    // the failed_ambiguous → delivered path IS the auto-reconciliation lane
    expect(queries[0].in).toContainEqual([
      "status",
      ["sent", "sending", "failed_ambiguous"],
    ]);
  });

  test("applyDeliveryReport(undelivered) records the carrier detail in last_error", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "undelivered" }),
    ]);
    h.client = client;

    await applyDeliveryReport("r1", {
      delivered: false,
      detail: "carrier rejected",
    });

    expect(queries[0].update).toMatchObject({
      status: "undelivered",
      last_error: "carrier rejected",
    });
  });

  test("applyDeliveryReport never overwrites a DIFFERENT known st_message_id (status still settles)", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "delivered", st_message_id: "st-old" }),
    ]);
    h.client = client;

    const row = await applyDeliveryReport("r1", {
      delivered: true,
      stMessageId: "st-9",
      currentStMessageId: "st-old",
    });

    expect(row?.status).toBe("delivered");
    expect(queries[0].update?.status).toBe("delivered");
    // the row already learned a different id — keep it
    expect(queries[0].update).not.toHaveProperty("st_message_id");
  });

  test("applyDeliveryReport re-writes st_message_id when it matches the row's known id", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "delivered", st_message_id: "st-9" }),
    ]);
    h.client = client;

    await applyDeliveryReport("r1", {
      delivered: true,
      stMessageId: "st-9",
      currentStMessageId: "st-9",
    });

    expect(queries[0].update?.st_message_id).toBe("st-9");
  });

  test("applyDeliveryReport returns null when the row is not in a settleable status", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await applyDeliveryReport("r1", { delivered: true })).toBeNull();
  });
});
