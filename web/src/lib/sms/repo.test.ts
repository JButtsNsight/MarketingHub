import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  getCampaignCounts,
  getCampaignRecipients,
  getSuppressedSet,
  listCampaignsWithCounts,
  markRecipientFailed,
  pauseCampaign,
  prepareRecipients,
  resumeCampaign,
  retryRecipient,
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

  test("retryRecipient re-queues failed_ambiguous|failed with send_after=now and re-opens a completed campaign", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "pending" }),
      ok(null),
    ]);
    h.client = client;

    const row = await retryRecipient("r1");

    expect(row?.id).toBe("r1");
    const retry = queries[0];
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
    const reopen = queries[1];
    expect(reopen.source).toBe("sms_campaigns");
    expect(reopen.update?.status).toBe("sending");
    expect(reopen.eq).toContainEqual(["id", "c1"]);
    expect(reopen.eq).toContainEqual(["status", "completed"]);
  });

  test("retryRecipient returns null (409) without touching the campaign when the guard loses", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;
    expect(await retryRecipient("r1")).toBeNull();
    expect(queries).toHaveLength(1);
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
