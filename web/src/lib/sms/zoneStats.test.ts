import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import {
  foldZoneCounts,
  getExplicitZoneCounts,
  zoneChip,
} from "./zoneStats";

interface QueryLog {
  table: string;
  schema: string | null;
  select: string | null;
  in: Array<[string, unknown[]]>;
  not: Array<[string, string, unknown]>;
  order: Array<[string, unknown]>;
  range: [number, number] | null;
}

type MockResult = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): MockResult => ({ data, error: null });
const err = (message: string): MockResult => ({
  data: null,
  error: { message },
});

/**
 * Chainable mock client in the repo.test.ts style, trimmed to the zone-stats
 * chain — `.range()` is the terminal await and consumes the next result.
 */
function buildClient(results: MockResult[] = []) {
  const queries: QueryLog[] = [];
  let next = 0;
  let currentSchema: string | null = null;

  function openQuery(table: string) {
    const log: QueryLog = {
      table,
      schema: currentSchema,
      select: null,
      in: [],
      not: [],
      order: [],
      range: null,
    };
    queries.push(log);
    const result = results[next++] ?? { data: null, error: null };

    const q: Record<string, unknown> = {};
    q.select = vi.fn((cols?: string) => {
      log.select = cols ?? "*";
      return q;
    });
    q.in = vi.fn((col: string, vals: unknown[]) => {
      log.in.push([col, vals]);
      return q;
    });
    q.not = vi.fn((col: string, op: string, val: unknown) => {
      log.not.push([col, op, val]);
      return q;
    });
    q.order = vi.fn((col: string, opts: unknown) => {
      log.order.push([col, opts]);
      return q;
    });
    q.range = vi.fn((from: number, to: number) => {
      log.range = [from, to];
      return Promise.resolve(result);
    });
    return q;
  }

  const from = vi.fn((table: string) => openQuery(table));
  const schema = vi.fn((s: string) => {
    currentSchema = s;
    return { from };
  });
  return { client: { schema }, queries };
}

const row = (campaign_id: string, send_timezone: string, count: number) => ({
  campaign_id,
  send_timezone,
  count,
});

describe("getExplicitZoneCounts", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("reads pre-aggregated campaign × zone counts off the view, null zones filtered at the DB", async () => {
    const { client, queries } = buildClient([
      ok([
        row("c1", "America/New_York", 1),
        row("c1", "America/Chicago", 2),
        row("c2", "Pacific/Honolulu", 1),
      ]),
    ]);
    h.client = client;

    // Duplicate ids collapse into one filter value.
    const map = await getExplicitZoneCounts(["c1", "c2", "c1"]);

    expect(map.get("c1")).toEqual(
      new Map([
        ["America/New_York", 1],
        ["America/Chicago", 2],
      ]),
    );
    expect(map.get("c2")).toEqual(new Map([["Pacific/Honolulu", 1]]));

    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.schema).toBe("marketinghub");
    // The aggregation is SQL-side: one view row per campaign × zone, never
    // one per recipient (a raw-row scan is O(every zoned recipient ever)).
    expect(q.table).toBe("sms_campaign_recipient_zone_counts");
    expect(q.select).toBe("campaign_id, send_timezone, count");
    expect(q.in).toEqual([["campaign_id", ["c1", "c2"]]]);
    expect(q.not).toEqual([["send_timezone", "is", null]]);
    expect(q.range).toEqual([0, 999]);
  });

  test("pages past a full first page of view rows", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) =>
      row(`c${i}`, "America/New_York", 3),
    );
    const { client, queries } = buildClient([
      ok(fullPage),
      ok([row("c0", "America/Chicago", 1)]),
    ]);
    h.client = client;

    const map = await getExplicitZoneCounts(
      Array.from({ length: 200 }, (_, i) => `c${i}`),
    );

    expect(queries).toHaveLength(2);
    expect(queries[0].range).toEqual([0, 999]);
    expect(queries[1].range).toEqual([1000, 1999]);
    expect(map.get("c0")).toEqual(
      new Map([
        ["America/New_York", 3],
        ["America/Chicago", 1],
      ]),
    );
  });

  test("chunks the id filter at 200 per query", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `c${i}`);
    const { client, queries } = buildClient([ok([]), ok([])]);
    h.client = client;

    await getExplicitZoneCounts(ids);

    expect(queries).toHaveLength(2);
    expect(queries[0].in[0][1]).toHaveLength(200);
    expect(queries[1].in[0][1]).toEqual(["c200"]);
  });

  test("no ids → no queries", async () => {
    const { client, queries } = buildClient();
    h.client = client;
    expect(await getExplicitZoneCounts([])).toEqual(new Map());
    expect(queries).toHaveLength(0);
  });

  test("fails loud on a PostgREST error", async () => {
    const { client } = buildClient([err("boom")]);
    h.client = client;
    await expect(getExplicitZoneCounts(["c1"])).rejects.toThrow(
      /zone-counts failed: boom/,
    );
  });
});

describe("foldZoneCounts", () => {
  test("no explicit rows → everything sits in the campaign zone", () => {
    expect(foldZoneCounts(undefined, "America/New_York", 12)).toEqual(
      new Map([["America/New_York", 12]]),
    );
  });

  test("the null-zone remainder folds into the campaign zone bucket", () => {
    const explicit = new Map([
      ["America/New_York", 3],
      ["America/Chicago", 4],
    ]);
    expect(foldZoneCounts(explicit, "America/New_York", 10)).toEqual(
      new Map([
        ["America/New_York", 6],
        ["America/Chicago", 4],
      ]),
    );
  });

  test("explicit rows covering the total leave the counts unchanged", () => {
    const explicit = new Map([["America/Chicago", 5]]);
    expect(foldZoneCounts(explicit, "America/New_York", 5)).toEqual(
      new Map([["America/Chicago", 5]]),
    );
  });

  test("zero rows → empty spread", () => {
    expect(foldZoneCounts(undefined, "America/New_York", 0)).toEqual(new Map());
  });
});

describe("zoneChip", () => {
  test("single-zone and empty audiences get no chip", () => {
    expect(zoneChip(new Map())).toBeNull();
    expect(zoneChip(new Map([["America/New_York", 40]]))).toBeNull();
  });

  test("multi-zone audiences get an N-zones label titled east to west", () => {
    const chip = zoneChip(
      new Map([
        ["America/Los_Angeles", 2],
        ["America/New_York", 3],
        ["America/Chicago", 1],
      ]),
    );
    expect(chip).toEqual({
      label: "3 zones",
      title: "ET 3 · CT 1 · PT 2",
    });
  });

  test("unknown zones sort last and fall back to the raw id", () => {
    const chip = zoneChip(
      new Map([
        ["Mars/Olympus", 1],
        ["Pacific/Honolulu", 2],
      ]),
    );
    expect(chip).toEqual({
      label: "2 zones",
      title: "HT 2 · Mars/Olympus 1",
    });
  });
});
