import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  addManualSuppression,
  applyDeliveryReport,
  cancelCampaign,
  claimDueRecipients,
  completeDrainedCampaigns,
  countSuppressions,
  countUnhandledInbound,
  createCampaign,
  findActiveDuplicateCampaign,
  findRecipientForDeliveryReport,
  findRecipientForInbound,
  getCampaign,
  getCampaignCounts,
  getCampaignEngagement,
  getCampaignRecipients,
  getCampaignStatuses,
  getEngagementForCampaigns,
  getLinkTarget,
  getPendingRecipientZones,
  getSuppressedSet,
  getSuppression,
  isSuppressed,
  listAttentionRecipients,
  listCampaignsWithCounts,
  listInboundMessages,
  listSuppressions,
  markAmbiguous,
  markFailed,
  markRecipientFailed,
  markRetry,
  markSending,
  markSent,
  pauseCampaign,
  prepareRecipients,
  promoteDueCampaigns,
  recordInboundMessage,
  recordLinkClick,
  recordSuppression,
  recordWebhookEvent,
  releaseClaim,
  releaseForConfigError,
  removeManualSuppression,
  rescheduleCampaign,
  resolveRecipientSent,
  resumeCampaign,
  retryRecipient,
  setInboundHandled,
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
  selectOptions: unknown;
  insert: unknown;
  update: Record<string, unknown> | null;
  upsert: { row: unknown; options: unknown } | null;
  delete: boolean;
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  is: Array<[string, unknown]>;
  ilike: Array<[string, unknown]>;
  lte: Array<[string, unknown]>;
  order: Array<[string, unknown]>;
  limit: number | null;
  single: boolean;
  maybeSingle: boolean;
}

type MockResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};

const ok = (data: unknown): MockResult => ({ data, error: null });
const err = (message: string): MockResult => ({
  data: null,
  error: { message },
});
/** For `{count: 'exact', head: true}` queries — data stays null. */
const okCount = (count: number): MockResult => ({
  data: null,
  error: null,
  count,
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
      selectOptions: null,
      insert: null,
      update: null,
      upsert: null,
      delete: false,
      eq: [],
      in: [],
      is: [],
      ilike: [],
      lte: [],
      order: [],
      limit: null,
      single: false,
      maybeSingle: false,
    };
    queries.push(log);
    const result = results[next++] ?? { data: null, error: null };

    const q: Record<string, unknown> = {};
    q.select = vi.fn((cols?: string, options?: unknown) => {
      log.select = cols ?? "*";
      log.selectOptions = options ?? null;
      return q;
    });
    q.delete = vi.fn(() => {
      log.delete = true;
      return q;
    });
    q.ilike = vi.fn((col: string, val: unknown) => {
      log.ilike.push([col, val]);
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
  contact_list_id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  monday_board_id: "12345",
  monday_phone_column_id: "phone",
  message_body: "Hi {{firstName}}",
  send_date: "2026-08-05",
  send_time: "11:30",
  send_timezone: "America/New_York",
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
  contactListId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  sendDate: "2026-08-05",
  sendTime: "11:30" as const,
  sendTimezone: "America/New_York" as const,
};

/** Monday coordinates as read off a linked-board contact list. */
const mondaySource = { mondayBoardId: "12345", mondayPhoneColumnId: "phone" };

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

  test("passes each row's normalized zone through as send_timezone (null when absent)", () => {
    const rows = prepareRecipients(
      [
        mondayRow({ zone: "Pacific/Honolulu" }),
        mondayRow({
          mondayItemId: "m2",
          phoneE164: "+15551230002",
          rawPhone: "555-123-0002",
        }),
      ],
      "Hi {{firstName}}",
      new Set(),
    );
    expect(rows[0].send_timezone).toBe("Pacific/Honolulu");
    expect(rows[1].send_timezone).toBeNull();
  });

  test("a zoneNote (unrecognized zone value) lands in last_error on pending rows; skip/suppress reasons outrank it", () => {
    const note = 'unrecognized timezone, campaign zone used (raw: EST)';
    const rows = prepareRecipients(
      [
        mondayRow({ zone: null, zoneNote: note }),
        mondayRow({
          mondayItemId: "m2",
          phoneE164: null,
          rawPhone: "not-a-phone",
          zone: null,
          zoneNote: note,
        }),
      ],
      "Hi {{firstName}}",
      new Set(),
    );
    // The fallback is never silent — audit trail per the Track B decision log.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].last_error).toBe(note);
    // A skipped row's reason wins; the zone note never masks it.
    expect(rows[1].status).toBe("skipped");
    expect(rows[1].last_error).toContain("not-a-phone");
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

  // DELIBERATE TEST UPDATE (defect F): the campaign is now born 'paused'
  // (non-dispatchable) and only flips paused → scheduled AFTER the last
  // recipient chunk lands — a crash mid-insert can no longer leave a partial
  // campaign that would dispatch.
  test("inserts the campaign snapshot as PAUSED, chunk-inserts recipients 200 at a time, then flips paused → scheduled as the final step", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(null),
      ok(null),
      ok(campaignRow), // the final paused → scheduled flip
    ]);
    h.client = client;

    const created = await createCampaign(
      validInput,
      mondaySource,
      "Hi {{firstName}}",
      prepared(450),
      user,
    );

    expect(created.id).toBe("c1");
    expect(created.status).toBe("scheduled");
    expect(queries[0].schema).toBe("marketinghub");
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].insert).toMatchObject({
      name: "August outreach",
      template_id: validInput.templateId,
      contact_list_id: validInput.contactListId,
      monday_board_id: "12345",
      monday_phone_column_id: "phone",
      message_body: "Hi {{firstName}}",
      send_date: "2026-08-05",
      send_time: "11:30",
      send_timezone: "America/New_York",
      // 2026-08-05 is EDT: 11:30 America/New_York === 15:30Z
      send_at: "2026-08-05T15:30:00.000Z",
      status: "paused",
      created_by: "amy@nsight.example",
    });
    expect(queries[0].single).toBe(true);

    // 450 recipients → 3 chunks of 200/200/50 into sms_campaign_recipients
    expect(queries).toHaveLength(5);
    const chunks = queries.slice(1, 4);
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
    // zoneless row: null send_timezone MEANS the campaign zone
    expect(firstRow.send_timezone).toBeNull();
    expect(firstRow.status).toBe("pending");
    expect(firstRow.rendered_text).toBe("Hi Person 0");

    // the go-live flip happens ONLY after the last chunk, guarded on paused
    const flip = queries[4];
    expect(flip.source).toBe("sms_campaigns");
    expect(flip.update?.status).toBe("scheduled");
    expect(flip.eq).toContainEqual(["id", "c1"]);
    expect(flip.eq).toContainEqual(["status", "paused"]);
    expect(flip.maybeSingle).toBe(true);
  });

  test("fails loud when the final paused → scheduled flip loses (campaign left visibly paused)", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(null), // flip matched 0 rows (someone canceled it mid-create)
    ]);
    h.client = client;

    await expect(
      createCampaign(validInput, mondaySource, "Hi {{firstName}}", prepared(10), user),
    ).rejects.toThrow(/\[sms\] create-activate failed/);
    expect(queries).toHaveLength(3);
  });

  test("a sheet-sourced campaign snapshots NULL Monday coordinates", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    await createCampaign(
      validInput,
      { mondayBoardId: null, mondayPhoneColumnId: null },
      "Hi {{firstName}}",
      prepared(1),
      user,
    );

    const insert = queries[0].insert as Record<string, unknown>;
    expect(insert.monday_board_id).toBeNull();
    expect(insert.monday_phone_column_id).toBeNull();
    expect(insert.contact_list_id).toBe(validInput.contactListId);
  });

  test("mixed-zone audience: per-row send_after in each row's zone, explicit zones stamped, send_at = the EARLIEST row instant", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    // validInput slot: 11:30 on 2026-08-05 → 15:30Z in ET, 21:30Z in HT.
    const rows = prepared(3);
    const zoned = [
      rows[0], // zoneless → campaign zone (ET)
      { ...rows[1], send_timezone: "Pacific/Honolulu" as const },
      { ...rows[2], send_timezone: "America/New_York" as const },
    ];
    await createCampaign(validInput, mondaySource, "Hi {{firstName}}", zoned, user);

    // the campaign fires with its EARLIEST row
    expect((queries[0].insert as Record<string, unknown>).send_at).toBe(
      "2026-08-05T15:30:00.000Z",
    );

    const chunk = queries[1].insert as Array<Record<string, unknown>>;
    expect(chunk.map((r) => r.send_after)).toEqual([
      "2026-08-05T15:30:00.000Z",
      "2026-08-05T21:30:00.000Z",
      "2026-08-05T15:30:00.000Z",
    ]);
    // only EXPLICIT zones are stamped; null = the campaign zone
    expect(chunk.map((r) => r.send_timezone)).toEqual([
      null,
      "Pacific/Honolulu",
      "America/New_York",
    ]);
  });

  test("an audience entirely in a LATER zone pulls send_at to that zone, not the campaign zone (min is over ROW instants)", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    const zoned = prepared(2).map((r) => ({
      ...r,
      send_timezone: "Pacific/Honolulu" as const,
    }));
    await createCampaign(validInput, mondaySource, "Hi {{firstName}}", zoned, user);

    expect((queries[0].insert as Record<string, unknown>).send_at).toBe(
      "2026-08-05T21:30:00.000Z",
    );
  });

  test("send_at mins over PENDING rows ONLY — a suppressed/skipped row's earlier zone cannot drag the campaign earlier", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    // Whole pending audience is HT (21:30Z); one never-sendable row per
    // non-dispatch status sits in ET (15:30Z). The route's past-slot gate
    // validates pending zones only — send_at must agree with it, or the
    // campaign promotes to 'sending' hours before any real row is due.
    const rows = prepared(3);
    const zoned = [
      { ...rows[0], send_timezone: "Pacific/Honolulu" as const },
      {
        ...rows[1],
        send_timezone: "America/New_York" as const,
        status: "suppressed" as const,
        last_error: "suppressed: phone is on the STOP list",
      },
      {
        ...rows[2],
        phone_e164: null,
        send_timezone: "America/New_York" as const,
        status: "skipped" as const,
        last_error: "skipped: no usable US phone (raw: n/a)",
      },
    ];
    await createCampaign(validInput, mondaySource, "Hi {{firstName}}", zoned, user);

    expect((queries[0].insert as Record<string, unknown>).send_at).toBe(
      "2026-08-05T21:30:00.000Z",
    );
    // The non-pending rows still snapshot their zone + instant for audit.
    const chunk = queries[1].insert as Array<Record<string, unknown>>;
    expect(chunk.map((r) => r.send_after)).toEqual([
      "2026-08-05T21:30:00.000Z",
      "2026-08-05T15:30:00.000Z",
      "2026-08-05T15:30:00.000Z",
    ]);
  });

  test("nothing pending at all: send_at falls back to the campaign-zone instant", async () => {
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    const zoned = prepared(1).map((r) => ({
      ...r,
      send_timezone: "Pacific/Honolulu" as const,
      status: "suppressed" as const,
      last_error: "suppressed: phone is on the STOP list",
    }));
    await createCampaign(validInput, mondaySource, "Hi {{firstName}}", zoned, user);

    // campaign zone (ET) instant, NOT the suppressed row's HT instant
    expect((queries[0].insert as Record<string, unknown>).send_at).toBe(
      "2026-08-05T15:30:00.000Z",
    );
  });

  test("chunk-insert failure best-effort cancels the campaign, then fails loud", async () => {
    const { client, queries } = buildClient([
      ok(campaignRow),
      err("unique violation"),
      ok(null), // best-effort cancel update
    ]);
    h.client = client;

    await expect(
      createCampaign(validInput, mondaySource, "Hi {{firstName}}", prepared(10), user),
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
      createCampaign(validInput, mondaySource, "Hi {{firstName}}", prepared(3), user),
    ).rejects.toThrow(/\[sms\] create failed: nope/);
    expect(queries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findActiveDuplicateCampaign — creation idempotency backstop
// ---------------------------------------------------------------------------
describe("findActiveDuplicateCampaign", () => {
  test("matches template_id + contact_list_id + send_date among scheduled|sending|paused", async () => {
    const { client, queries } = buildClient([ok([campaignRow])]);
    h.client = client;

    const dupe = await findActiveDuplicateCampaign(
      validInput.templateId,
      validInput.contactListId,
      "2026-08-05",
    );

    expect(dupe?.id).toBe("c1");
    expect(queries[0].source).toBe("sms_campaigns");
    expect(queries[0].eq).toContainEqual(["template_id", validInput.templateId]);
    expect(queries[0].eq).toContainEqual([
      "contact_list_id",
      validInput.contactListId,
    ]);
    expect(queries[0].eq).toContainEqual(["send_date", "2026-08-05"]);
    // terminal campaigns (completed/canceled) never block a re-create
    expect(queries[0].in).toContainEqual([
      "status",
      ["scheduled", "sending", "paused"],
    ]);
    expect(queries[0].limit).toBe(1);
  });

  test("returns null when no active duplicate exists", async () => {
    const { client } = buildClient([ok([])]);
    h.client = client;
    expect(
      await findActiveDuplicateCampaign(
        validInput.templateId,
        validInput.contactListId,
        "2026-08-05",
      ),
    ).toBeNull();
  });

  test("fails loud on a PostgREST error", async () => {
    const { client } = buildClient([err("db down")]);
    h.client = client;
    await expect(
      findActiveDuplicateCampaign(validInput.templateId, validInput.contactListId, "2026-08-05"),
    ).rejects.toThrow(/\[sms\].*db down/);
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

  test("listCampaignsWithCounts chunks >200 campaign ids across .in() queries and merges the counts", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      ...campaignRow,
      id: `c${i}`,
    }));
    const { client, queries } = buildClient([
      ok(many),
      ok([{ campaign_id: "c0", status: "pending", count: 3 }]),
      ok([{ campaign_id: "c249", status: "sent", count: 7 }]),
    ]);
    h.client = client;

    const list = await listCampaignsWithCounts();

    // 1 campaigns read + 2 chunked counts-view reads (200/50)
    expect(queries).toHaveLength(3);
    expect(queries[1].source).toBe("sms_campaign_recipient_counts");
    expect(queries[1].in[0][0]).toBe("campaign_id");
    expect(queries[1].in[0][1]).toHaveLength(200);
    expect(queries[2].in[0][1]).toHaveLength(50);
    expect(queries[2].in[0][1]).toContain("c249");

    // counts from BOTH chunks land on the right campaigns
    expect(list).toHaveLength(250);
    expect(list[0].counts.pending).toBe(3);
    expect(list[249].counts.sent).toBe(7);
    expect(list[1].counts.pending).toBe(0); // zero-filled
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
// Per-recipient timezones — zone groups + the per-zone reschedule sweep
// ---------------------------------------------------------------------------
describe("getPendingRecipientZones", () => {
  test("probes one HEAD count per candidate zone (5 ids + null) and returns only the present groups", async () => {
    const { client, queries } = buildClient([
      okCount(2), // America/New_York
      okCount(0), // America/Chicago
      okCount(0), // America/Denver
      okCount(0), // America/Los_Angeles
      okCount(1), // Pacific/Honolulu
      okCount(3), // null → the campaign zone
    ]);
    h.client = client;

    const zones = await getPendingRecipientZones("c1");

    expect(zones).toEqual(["America/New_York", "Pacific/Honolulu", null]);
    expect(queries).toHaveLength(6);
    for (const q of queries) {
      expect(q.source).toBe("sms_campaign_recipients");
      expect(q.selectOptions).toEqual({ count: "exact", head: true });
      expect(q.eq).toContainEqual(["campaign_id", "c1"]);
      expect(q.eq).toContainEqual(["status", "pending"]);
    }
    expect(queries[0].eq).toContainEqual(["send_timezone", "America/New_York"]);
    expect(queries[4].eq).toContainEqual(["send_timezone", "Pacific/Honolulu"]);
    // the campaign-zone group filters on send_timezone IS NULL
    expect(queries[5].is).toContainEqual(["send_timezone", null]);
  });

  test("fails loud when a count errors", async () => {
    const { client } = buildClient([okCount(0), err("db down")]);
    h.client = client;
    await expect(getPendingRecipientZones("c1")).rejects.toThrow(
      /\[sms\] pending-zones failed: db down/,
    );
  });
});

describe("rescheduleCampaign", () => {
  // 2026-08-06 is a Thursday; 09:00 CDT = 14:00Z, 09:00 HST = 19:00Z.
  const rescheduleInput = {
    sendDate: "2026-08-06",
    sendTime: "09:00" as const,
    sendTimezone: "America/Chicago" as const,
  };

  test("sweeps the FULL closed zone set; explicit zones keep THEIR slot, null zones follow the NEW campaign zone; send_at = the earliest PENDING-group instant", async () => {
    const { client, queries } = buildClient([
      okCount(0), // America/New_York
      okCount(0), // America/Chicago
      okCount(0), // America/Denver
      okCount(0), // America/Los_Angeles
      okCount(1), // Pacific/Honolulu
      okCount(2), // null → campaign zone
      ok({ ...campaignRow, send_timezone: "America/Chicago" }),
      ok(null), // ET sweep
      ok(null), // CT sweep
      ok(null), // MT sweep
      ok(null), // PT sweep
      ok(null), // HT sweep
      ok(null), // campaign-zone (null) sweep
    ]);
    h.client = client;

    const updated = await rescheduleCampaign("c1", rescheduleInput);

    expect(updated?.id).toBe("c1");
    const campaignUpdate = queries[6];
    expect(campaignUpdate.source).toBe("sms_campaigns");
    expect(campaignUpdate.update).toMatchObject({
      send_date: "2026-08-06",
      send_time: "09:00",
      send_timezone: "America/Chicago",
      // min over PENDING groups only: min(HT 19:00Z, CT 14:00Z)
      send_at: "2026-08-06T14:00:00.000Z",
    });
    expect(campaignUpdate.eq).toContainEqual(["id", "c1"]);
    expect(campaignUpdate.in).toContainEqual([
      "status",
      ["scheduled", "paused"],
    ]);
    expect(campaignUpdate.maybeSingle).toBe(true);

    // Every candidate zone is swept — NOT just the snapshotted groups: a row
    // can turn pending between the probe and the sweeps (retryRecipient /
    // markRetry), and a snapshot-filtered sweep would strand it due-now in a
    // never-iterated group.
    const sweeps = queries.slice(7);
    expect(sweeps).toHaveLength(6);
    for (const sweep of sweeps) {
      expect(sweep.source).toBe("sms_campaign_recipients");
      expect(sweep.eq).toContainEqual(["campaign_id", "c1"]);
      // the durability guard, exactly as-is — zone filters only NARROW it
      expect(sweep.eq).toContainEqual(["status", "pending"]);
    }
    // explicit rows get the new date + slot in THEIR zone (east → west)…
    expect(sweeps.slice(0, 5).map((q) => q.update?.send_after)).toEqual([
      "2026-08-06T13:00:00.000Z", // ET
      "2026-08-06T14:00:00.000Z", // CT
      "2026-08-06T15:00:00.000Z", // MT
      "2026-08-06T16:00:00.000Z", // PT
      "2026-08-06T19:00:00.000Z", // HT
    ]);
    expect(sweeps[4].eq).toContainEqual(["send_timezone", "Pacific/Honolulu"]);
    // …and null-zone rows follow the campaign zone — including a CHANGED one
    const fallbackSweep = sweeps[5];
    expect(fallbackSweep.update?.send_after).toBe("2026-08-06T14:00:00.000Z");
    expect(fallbackSweep.is).toContainEqual(["send_timezone", null]);
    expect(queries).toHaveLength(13);
  });

  test("zoneless campaign: every pending row is caught by the null-group sweep at the campaign-zone instant", async () => {
    const { client, queries } = buildClient([
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(4), // every pending row is campaign-zone
      ok(campaignRow),
    ]);
    h.client = client;

    const updated = await rescheduleCampaign("c1", rescheduleInput);

    expect(updated?.id).toBe("c1");
    expect(queries[6].update?.send_at).toBe("2026-08-06T14:00:00.000Z");
    const sweep = queries[12]; // the null group sweeps LAST
    expect(sweep.update?.send_after).toBe("2026-08-06T14:00:00.000Z");
    expect(sweep.is).toContainEqual(["send_timezone", null]);
    expectRecentIso(sweep.update?.updated_at);
    // send_after + updated_at only — no restamp; null still MEANS campaign zone
    expect(Object.keys(sweep.update ?? {}).sort()).toEqual([
      "send_after",
      "updated_at",
    ]);
    expect(queries).toHaveLength(13);
  });

  test("returns null (409) after the zone probes, without sweeping, when the guard loses", async () => {
    const { client, queries } = buildClient([
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(1),
      ok(null), // campaign no longer scheduled|paused
    ]);
    h.client = client;

    expect(await rescheduleCampaign("c1", rescheduleInput)).toBeNull();
    expect(queries).toHaveLength(7);
  });

  test("no pending rows: send_at falls back to the campaign-zone instant; the catch-all sweeps still run", async () => {
    const { client, queries } = buildClient([
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      okCount(0),
      ok(campaignRow),
    ]);
    h.client = client;

    const updated = await rescheduleCampaign("c1", rescheduleInput);

    expect(updated?.id).toBe("c1");
    expect(queries[6].update?.send_at).toBe("2026-08-06T14:00:00.000Z");
    // 6 probes + campaign update + 6 catch-all sweeps (0-row updates when
    // nothing raced in — cheap insurance against a mid-request retry).
    expect(queries).toHaveLength(13);
    for (const sweep of queries.slice(7)) {
      expect(sweep.eq).toContainEqual(["status", "pending"]);
    }
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
    // The frequency-cap args default to 0/0 — the RPC treats that as OFF.
    expect(queries[0].rpcArgs).toEqual({
      batch_size: 25,
      claim_ttl_seconds: 180,
      freq_cap_count: 0,
      freq_cap_days: 0,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("claimed");
  });

  test("claimDueRecipients passes an explicit frequency cap through to the RPC", async () => {
    const { client, queries } = buildClient([ok([])]);
    h.client = client;

    await claimDueRecipients(25, 180, 2, 7);

    expect(queries[0].rpcArgs).toEqual({
      batch_size: 25,
      claim_ttl_seconds: 180,
      freq_cap_count: 2,
      freq_cap_days: 7,
    });
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

  // DELIBERATE TEST UPDATE (defect E): a compensating counts re-check now
  // follows the completed-update — asserted as queries[3] here.
  test("completeDrainedCampaigns completes sending campaigns with zero active rows (guarded)", async () => {
    const { client, queries } = buildClient([
      ok([{ id: "c1" }, { id: "c2" }, { id: "c3" }]),
      ok([{ campaign_id: "c2" }]), // c2 still has active rows
      ok([{ id: "c1" }, { id: "c3" }]),
      ok([]), // compensating re-check: nothing re-activated
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

    // post-update re-check of just the completed ids; no compensation needed
    expect(queries).toHaveLength(4);
    expect(queries[3].source).toBe("sms_campaign_recipient_counts");
    expect(queries[3].in).toContainEqual(["campaign_id", ["c1", "c3"]]);
  });

  test("completeDrainedCampaigns compensates a retry that landed between the counts read and the update", async () => {
    const { client, queries } = buildClient([
      ok([{ id: "c1" }, { id: "c2" }]), // sending campaigns
      ok([]), // first counts read: both look drained
      ok([{ id: "c1" }, { id: "c2" }]), // completed update wins both
      // re-check: a retryRecipient landed on c1 in the window — it now has an
      // active pending row stranded inside a 'completed' campaign
      ok([{ campaign_id: "c1" }]),
      ok(null), // compensating completed → sending update
    ]);
    h.client = client;

    const completed = await completeDrainedCampaigns();

    expect(queries[3].source).toBe("sms_campaign_recipient_counts");
    expect(queries[3].in).toContainEqual(["campaign_id", ["c1", "c2"]]);
    expect(queries[3].in).toContainEqual([
      "status",
      ["pending", "claimed", "sending"],
    ]);

    const compensate = queries[4];
    expect(compensate.source).toBe("sms_campaigns");
    expect(compensate.update?.status).toBe("sending");
    expect(compensate.in).toContainEqual(["id", ["c1"]]);
    // guarded so a concurrent pause/cancel still wins over the re-open
    expect(compensate.eq).toContainEqual(["status", "completed"]);

    // only the campaign that STAYED completed is reported
    expect(completed).toEqual(["c2"]);
  });

  test("completeDrainedCampaigns chunks >200 sending ids on the counts view and merges the active set", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}` }));
    const drained = many
      .map((r) => r.id)
      .filter((id) => id !== "c0" && id !== "c249");
    const { client, queries } = buildClient([
      ok(many),
      ok([{ campaign_id: "c0" }]), // chunk 1: c0 still active
      ok([{ campaign_id: "c249" }]), // chunk 2: c249 still active
      ok(drained.map((id) => ({ id }))),
    ]);
    h.client = client;

    const completed = await completeDrainedCampaigns();

    // two chunked counts-view reads (200/50), both status-scoped
    expect(queries[1].source).toBe("sms_campaign_recipient_counts");
    expect(queries[1].in).toContainEqual([
      "campaign_id",
      many.slice(0, 200).map((r) => r.id),
    ]);
    expect(queries[1].in).toContainEqual([
      "status",
      ["pending", "claimed", "sending"],
    ]);
    expect(queries[2].source).toBe("sms_campaign_recipient_counts");
    expect(queries[2].in).toContainEqual([
      "campaign_id",
      many.slice(200).map((r) => r.id),
    ]);

    // hits from BOTH chunks are excluded from the completed update
    const complete = queries[3];
    expect(complete.source).toBe("sms_campaigns");
    expect(complete.update?.status).toBe("completed");
    expect(complete.in).toContainEqual(["id", drained]);

    expect(completed).toEqual(drained);
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

// ---------------------------------------------------------------------------
// Tracked links — creation-time persistence + redirect accessors
// ---------------------------------------------------------------------------
describe("tracked links", () => {
  test("createCampaign with links selects fresh ids, then inserts sms_links rows keyed on them", async () => {
    const prepared = [
      {
        monday_item_id: null,
        name: "Jane Doe",
        first_name: "Jane",
        phone_e164: "+15552000001",
        rendered_text: "Hi Jane https://x/l/s1s1s1s1",
        status: "pending" as const,
        last_error: null,
        links: [{ slug: "s1s1s1s1", targetUrl: "https://book.example.com/a" }],
      },
      {
        monday_item_id: null,
        name: "Sam Roe",
        first_name: "Sam",
        phone_e164: "+15552000002",
        rendered_text: "Hi Sam, no links here",
        status: "pending" as const,
        last_error: null,
      },
    ];
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok([
        { id: "r-a", rendered_text: "Hi Jane https://x/l/s1s1s1s1" },
        { id: "r-b", rendered_text: "Hi Sam, no links here" },
      ]),
      ok(null), // sms_links insert
      ok(campaignRow), // the final paused → scheduled flip
    ]);
    h.client = client;

    await createCampaign(
      validInput,
      mondaySource,
      "Hi {{firstName}}",
      prepared,
      user,
    );

    // The recipient chunk insert must NOT carry the bookkeeping `links` key…
    const chunk = queries[1];
    expect(chunk.source).toBe("sms_campaign_recipients");
    const chunkRows = chunk.insert as Array<Record<string, unknown>>;
    expect(chunkRows[0]).not.toHaveProperty("links");
    // …and asks the fresh ids back for the link rows.
    expect(chunk.select).toBe("id, rendered_text");

    const linkInsert = queries[2];
    expect(linkInsert.source).toBe("sms_links");
    expect(linkInsert.insert).toEqual([
      {
        slug: "s1s1s1s1",
        campaign_id: "c1",
        recipient_id: "r-a",
        target_url: "https://book.example.com/a",
      },
    ]);

    // go-live flip still last
    expect(queries[3].update?.status).toBe("scheduled");
  });

  test("createCampaign without links keeps the plain insert (no select round-trip)", async () => {
    const prepared = [
      {
        monday_item_id: null,
        name: "Jane Doe",
        first_name: "Jane",
        phone_e164: "+15552000001",
        rendered_text: "Hi Jane",
        status: "pending" as const,
        last_error: null,
      },
    ];
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok(null),
      ok(campaignRow),
    ]);
    h.client = client;

    await createCampaign(
      validInput,
      mondaySource,
      "Hi {{firstName}}",
      prepared,
      user,
    );

    expect(queries).toHaveLength(3);
    expect(queries[1].select).toBeNull();
  });

  test("createCampaign cancels and fails loud when returned rows do not match insert order", async () => {
    const prepared = [
      {
        monday_item_id: null,
        name: "Jane Doe",
        first_name: "Jane",
        phone_e164: "+15552000001",
        rendered_text: "Hi Jane https://x/l/s1s1s1s1",
        status: "pending" as const,
        last_error: null,
        links: [{ slug: "s1s1s1s1", targetUrl: "https://book.example.com/a" }],
      },
    ];
    const { client, queries } = buildClient([
      ok({ ...campaignRow, status: "paused" }),
      ok([{ id: "r-a", rendered_text: "SOMETHING ELSE" }]),
      ok(null), // best-effort cancel update
    ]);
    h.client = client;

    await expect(
      createCampaign(validInput, mondaySource, "Hi {{firstName}}", prepared, user),
    ).rejects.toThrow(/\[sms\] create-links failed/);

    const cancel = queries[2];
    expect(cancel.source).toBe("sms_campaigns");
    expect(cancel.update?.status).toBe("canceled");
  });

  test("getLinkTarget resolves a slug to id + target, null when unknown", async () => {
    const { client, queries } = buildClient([
      ok({ id: "l1", target_url: "https://book.example.com/a" }),
    ]);
    h.client = client;

    const link = await getLinkTarget("s1s1s1s1");

    expect(queries[0].source).toBe("sms_links");
    expect(queries[0].select).toBe("id, target_url");
    expect(queries[0].eq).toContainEqual(["slug", "s1s1s1s1"]);
    expect(queries[0].maybeSingle).toBe(true);
    expect(link).toEqual({ id: "l1", target_url: "https://book.example.com/a" });

    const { client: emptyClient } = buildClient([ok(null)]);
    h.client = emptyClient;
    expect(await getLinkTarget("unknown1")).toBeNull();
  });

  test("recordLinkClick inserts a click row and truncates absurd user agents", async () => {
    const { client, queries } = buildClient([ok(null), ok(null)]);
    h.client = client;

    await recordLinkClick("l1", "TestAgent/1.0");
    await recordLinkClick("l1", "x".repeat(9000));

    expect(queries[0].source).toBe("sms_link_clicks");
    expect(queries[0].insert).toEqual({
      link_id: "l1",
      user_agent: "TestAgent/1.0",
    });
    const longAgent = (queries[1].insert as { user_agent: string }).user_agent;
    expect(longAgent).toHaveLength(512);
  });
});

// ---------------------------------------------------------------------------
// Inbound messages — the reply inbox
// ---------------------------------------------------------------------------
describe("inbound messages", () => {
  test("recordInboundMessage inserts the reply with attribution and returns the id", async () => {
    const { client, queries } = buildClient([ok({ id: "in-1" })]);
    h.client = client;

    const id = await recordInboundMessage({
      phone: "+15550000004",
      body: "Yes please",
      raw: { text: "Yes please" },
      matchedRecipientId: "r7",
      matchedCampaignId: "c-3",
    });

    expect(id).toBe("in-1");
    expect(queries[0].source).toBe("sms_inbound_messages");
    expect(queries[0].insert).toEqual({
      phone_e164: "+15550000004",
      body: "Yes please",
      raw: { text: "Yes please" },
      matched_recipient_id: "r7",
      matched_campaign_id: "c-3",
    });
  });

  test("findRecipientForInbound picks the newest row that actually left our system", async () => {
    const { client, queries } = buildClient([ok([recipientRow])]);
    h.client = client;

    const row = await findRecipientForInbound("+15550000004");

    expect(row?.id).toBe(recipientRow.id);
    expect(queries[0].eq).toContainEqual(["phone_e164", "+15550000004"]);
    expect(queries[0].in).toContainEqual([
      "status",
      ["sent", "delivered", "undelivered", "failed_ambiguous"],
    ]);
    expect(queries[0].order).toContainEqual([
      "updated_at",
      { ascending: false },
    ]);
    expect(queries[0].limit).toBe(1);
  });

  test("listInboundMessages embeds the campaign and honors the filters", async () => {
    const { client, queries } = buildClient([ok([])]);
    h.client = client;

    await listInboundMessages({ unhandledOnly: true, campaignId: "c-3" });

    expect(queries[0].source).toBe("sms_inbound_messages");
    expect(queries[0].select).toBe("*, campaign:sms_campaigns(id, name)");
    expect(queries[0].eq).toContainEqual(["handled", false]);
    expect(queries[0].eq).toContainEqual(["matched_campaign_id", "c-3"]);
    expect(queries[0].order).toContainEqual([
      "received_at",
      { ascending: false },
    ]);
    expect(queries[0].limit).toBe(200);
  });

  test("setInboundHandled stamps who/when on handle and clears both on reopen", async () => {
    const { client, queries } = buildClient([
      ok({ id: "in-1", handled: true }),
      ok({ id: "in-1", handled: false }),
    ]);
    h.client = client;

    await setInboundHandled("in-1", true, "amy@nsight.example");
    await setInboundHandled("in-1", false, "amy@nsight.example");

    expect(queries[0].update?.handled).toBe(true);
    expect(queries[0].update?.handled_by).toBe("amy@nsight.example");
    expect(queries[0].update?.handled_at).toEqual(expect.any(String));
    expect(queries[1].update).toEqual({
      handled: false,
      handled_by: null,
      handled_at: null,
    });
  });

  test("setInboundHandled returns null for an unknown row", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await setInboundHandled("nope", true, "amy@x")).toBeNull();
  });

  test("countUnhandledInbound issues a head count over handled=false", async () => {
    const { client, queries } = buildClient([okCount(3)]);
    h.client = client;

    expect(await countUnhandledInbound()).toBe(3);
    expect(queries[0].selectOptions).toEqual({ count: "exact", head: true });
    expect(queries[0].eq).toContainEqual(["handled", false]);
  });
});

// ---------------------------------------------------------------------------
// Suppression management — the /suppressions page
// ---------------------------------------------------------------------------
describe("suppression management", () => {
  const suppressionRow = {
    phone_e164: "+15550000006",
    reason: "manual" as const,
    raw: { added_by: "amy@nsight.example", note: null },
    created_at: "2026-08-05T12:00:00Z",
  };

  test("listSuppressions searches by digits (input stripped) and lists newest first", async () => {
    const { client, queries } = buildClient([ok([suppressionRow])]);
    h.client = client;

    const rows = await listSuppressions({ query: "(555) 000" });

    expect(rows).toHaveLength(1);
    expect(queries[0].ilike).toContainEqual(["phone_e164", "%555000%"]);
    expect(queries[0].order).toContainEqual([
      "created_at",
      { ascending: false },
    ]);
    expect(queries[0].limit).toBe(200);
  });

  test("listSuppressions with a digit-free query returns [] without querying", async () => {
    const { client, queries } = buildClient([]);
    h.client = client;
    expect(await listSuppressions({ query: "hello" })).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  test("countSuppressions issues a head count", async () => {
    const { client, queries } = buildClient([okCount(42)]);
    h.client = client;
    expect(await countSuppressions()).toBe(42);
    expect(queries[0].selectOptions).toEqual({ count: "exact", head: true });
  });

  test("addManualSuppression inserts, sweeps the outbox, and writes the audit row", async () => {
    const { client, queries } = buildClient([
      ok(null), // getSuppression — not yet on the list
      ok(suppressionRow), // insert
      ok([{ id: "r1" }]), // suppressActiveRecipientsByPhone sweep
      ok(null), // audit insert
    ]);
    h.client = client;

    const result = await addManualSuppression(
      "+15550000006",
      "amy@nsight.example",
      "asked by phone",
    );

    expect(result.created).toBe(true);
    expect(queries[1].source).toBe("sms_suppressions");
    expect(queries[1].insert).toEqual({
      phone_e164: "+15550000006",
      reason: "manual",
      raw: { added_by: "amy@nsight.example", note: "asked by phone" },
    });
    expect(queries[2].source).toBe("sms_campaign_recipients");
    expect(queries[2].update?.status).toBe("suppressed");
    expect(queries[3].source).toBe("sms_suppression_audit");
    expect(queries[3].insert).toEqual({
      phone_e164: "+15550000006",
      action: "added",
      reason: "manual",
      actor: "amy@nsight.example",
      note: "asked by phone",
    });
  });

  test("addManualSuppression leaves an existing entry untouched (created: false, no sweep/audit)", async () => {
    const stopRow = { ...suppressionRow, reason: "stop" as const };
    const { client, queries } = buildClient([ok(stopRow)]);
    h.client = client;

    const result = await addManualSuppression("+15550000006", "amy@x");

    expect(result).toEqual({ created: false, suppression: stopRow });
    expect(queries).toHaveLength(1);
  });

  test("addManualSuppression treats an insert race as created: false via read-back", async () => {
    const { client, queries } = buildClient([
      ok(null), // getSuppression — not there yet
      err("duplicate key value violates unique constraint"),
      ok(suppressionRow), // raced read-back
    ]);
    h.client = client;

    const result = await addManualSuppression("+15550000006", "amy@x");

    expect(result.created).toBe(false);
    expect(queries).toHaveLength(3);
  });

  test("removeManualSuppression deletes ONLY manual entries and audits the removal", async () => {
    const { client, queries } = buildClient([
      ok(suppressionRow), // guarded delete returns the removed row
      ok(null), // audit insert
    ]);
    h.client = client;

    const removed = await removeManualSuppression(
      "+15550000006",
      "amy@nsight.example",
    );

    expect(removed?.phone_e164).toBe("+15550000006");
    expect(queries[0].delete).toBe(true);
    expect(queries[0].eq).toContainEqual(["phone_e164", "+15550000006"]);
    expect(queries[0].eq).toContainEqual(["reason", "manual"]);
    expect(queries[1].source).toBe("sms_suppression_audit");
    expect(queries[1].insert).toMatchObject({
      phone_e164: "+15550000006",
      action: "removed",
      actor: "amy@nsight.example",
    });
  });

  test("removeManualSuppression returns null (no audit) when the guard loses", async () => {
    const { client, queries } = buildClient([ok(null)]);
    h.client = client;
    expect(await removeManualSuppression("+15550000006", "amy@x")).toBeNull();
    expect(queries).toHaveLength(1);
  });

  test("getSuppression reads one row by phone", async () => {
    const { client, queries } = buildClient([ok(suppressionRow)]);
    h.client = client;
    const row = await getSuppression("+15550000006");
    expect(row?.reason).toBe("manual");
    expect(queries[0].eq).toContainEqual(["phone_e164", "+15550000006"]);
  });
});

// ---------------------------------------------------------------------------
// Needs-attention queue + manual mark-sent resolution
// ---------------------------------------------------------------------------
describe("attention queue", () => {
  test("listAttentionRecipients embeds the campaign and scopes to the attention statuses", async () => {
    const { client, queries } = buildClient([ok([])]);
    h.client = client;

    await listAttentionRecipients();

    expect(queries[0].source).toBe("sms_campaign_recipients");
    expect(queries[0].select).toBe("*, campaign:sms_campaigns(id, name, status)");
    expect(queries[0].in).toContainEqual([
      "status",
      ["failed_ambiguous", "failed", "undelivered"],
    ]);
    expect(queries[0].order).toContainEqual([
      "updated_at",
      { ascending: false },
    ]);
    expect(queries[0].limit).toBe(500);
  });

  test("resolveRecipientSent settles failed_ambiguous → sent with the note as audit", async () => {
    const { client, queries } = buildClient([
      ok({ ...recipientRow, status: "sent" }),
    ]);
    h.client = client;

    const row = await resolveRecipientSent("r1", "recipient replied");

    expect(row?.status).toBe("sent");
    expect(queries[0].update?.status).toBe("sent");
    expect(queries[0].update?.last_error).toBe("recipient replied");
    expect(queries[0].eq).toContainEqual(["id", "r1"]);
    expect(queries[0].eq).toContainEqual(["status", "failed_ambiguous"]);
  });

  test("resolveRecipientSent returns null when the row is not failed_ambiguous", async () => {
    const { client } = buildClient([ok(null)]);
    h.client = client;
    expect(await resolveRecipientSent("r1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Engagement aggregates
// ---------------------------------------------------------------------------
describe("engagement aggregates", () => {
  const engagementRow = {
    campaign_id: "c1",
    tracked_links: 2,
    recipients_clicked: 5,
    total_clicks: 9,
    replies: 3,
    unhandled_replies: 1,
    opt_outs: 1,
  };

  test("getCampaignEngagement reads the view, zero-filling a missing row", async () => {
    const { client, queries } = buildClient([ok(engagementRow)]);
    h.client = client;

    const row = await getCampaignEngagement("c1");
    expect(row).toEqual(engagementRow);
    expect(queries[0].source).toBe("sms_campaign_engagement");

    const { client: emptyClient } = buildClient([ok(null)]);
    h.client = emptyClient;
    const zero = await getCampaignEngagement("c-none");
    expect(zero).toEqual({
      campaign_id: "c-none",
      tracked_links: 0,
      recipients_clicked: 0,
      total_clicks: 0,
      replies: 0,
      unhandled_replies: 0,
      opt_outs: 0,
    });
  });

  test("getEngagementForCampaigns dedupes ids, chunks the .in(), and maps by campaign", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `c${i}`);
    const { client, queries } = buildClient([
      ok([engagementRow]),
      ok([]),
    ]);
    h.client = client;

    const map = await getEngagementForCampaigns([...ids, ...ids]);

    expect(queries).toHaveLength(2);
    expect((queries[0].in[0][1] as unknown[]).length).toBe(200);
    expect((queries[1].in[0][1] as unknown[]).length).toBe(50);
    expect(map.get("c1")).toEqual(engagementRow);
  });
});
