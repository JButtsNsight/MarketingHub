// @vitest-environment node
// boards.ts is pure orchestration over the mocked GraphQL transport — node
// env keeps it honest about not needing any DOM.
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the transport: boards.ts must never talk HTTP itself.
const h = vi.hoisted(() => ({
  mondayGraphQL: vi.fn<
    (query: string, variables?: Record<string, unknown>) => Promise<unknown>
  >(),
}));

vi.mock("./client", () => ({
  mondayGraphQL: h.mondayGraphQL,
}));

import { fetchBoardRecipients, getBoardMeta } from "./boards";

beforeEach(() => {
  h.mondayGraphQL.mockReset();
});

/** A Monday item whose phone column is a real `phone`-type column. */
function phoneItem(
  id: string,
  name: string,
  phone: string | null,
  countryShortName: string | null = "US",
) {
  return {
    id,
    name,
    column_values: [
      {
        id: "phone_col",
        text: phone ?? "",
        phone,
        country_short_name: countryShortName,
      },
    ],
  };
}

describe("getBoardMeta", () => {
  test("queries boards(ids:[...]) for id/name/columns and maps the result", async () => {
    h.mondayGraphQL.mockResolvedValueOnce({
      boards: [
        {
          id: "4567890123",
          name: "Patient Outreach",
          columns: [
            { id: "name", title: "Name", type: "name" },
            { id: "phone_col", title: "Phone", type: "phone" },
            { id: "text_col", title: "Cell", type: "text" },
          ],
        },
      ],
    });

    const meta = await getBoardMeta("4567890123");

    expect(h.mondayGraphQL).toHaveBeenCalledTimes(1);
    const [query, variables] = h.mondayGraphQL.mock.calls[0];
    expect(query).toContain("boards(ids:");
    expect(query).toContain("columns");
    for (const field of ["id", "title", "type"]) {
      expect(query).toContain(field);
    }
    // The board id travels as a GraphQL variable, not string-spliced.
    expect(JSON.stringify(variables)).toContain("4567890123");

    expect(meta).toEqual({
      id: "4567890123",
      name: "Patient Outreach",
      columns: [
        { id: "name", title: "Name", type: "name" },
        { id: "phone_col", title: "Phone", type: "phone" },
        { id: "text_col", title: "Cell", type: "text" },
      ],
    });
  });

  test("returns null when the board does not exist (empty boards array)", async () => {
    h.mondayGraphQL.mockResolvedValueOnce({ boards: [] });
    await expect(getBoardMeta("999")).resolves.toBeNull();
  });

  test("returns null when boards comes back null (tolerant of odd payloads)", async () => {
    h.mondayGraphQL.mockResolvedValueOnce({ boards: null });
    await expect(getBoardMeta("999")).resolves.toBeNull();
  });
});

describe("fetchBoardRecipients — single page mapping", () => {
  function firstPage(items: unknown[], cursor: string | null = null) {
    return { boards: [{ items_page: { cursor, items } }] };
  }

  test("maps PhoneValue rows through normalizeUsPhone + firstNameOf", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([phoneItem("1", "Jane Q Doe", "15551230001", "US")]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows).toEqual([
      {
        mondayItemId: "1",
        name: "Jane Q Doe",
        firstName: "Jane",
        phoneE164: "+15551230001",
        rawPhone: "15551230001",
        rawTimezone: null,
      },
    ]);
  });

  test("requests only the phone column and the PhoneValue fragment", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(firstPage([]));

    await fetchBoardRecipients("4567890123", "phone_col");

    const [query, variables] = h.mondayGraphQL.mock.calls[0];
    expect(query).toContain("items_page");
    expect(query).toContain("limit: 500");
    expect(query).toContain("... on PhoneValue");
    expect(query).toContain("country_short_name");
    expect(JSON.stringify(variables)).toContain("phone_col");
    expect(JSON.stringify(variables)).toContain("4567890123");
  });

  test("non-US country_short_name → phoneE164 null, rawPhone preserved for audit", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([phoneItem("2", "Nigel Bly", "441632960000", "GB")]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows).toEqual([
      {
        mondayItemId: "2",
        name: "Nigel Bly",
        firstName: "Nigel",
        phoneE164: null,
        rawPhone: "441632960000",
        rawTimezone: null,
      },
    ]);
  });

  test("empty PhoneValue (blank cell) → phoneE164 null, rawPhone ''", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([phoneItem("3", "No Phone", null, null)]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows[0]).toEqual({
      mondayItemId: "3",
      name: "No Phone",
      firstName: "No",
      phoneE164: null,
      rawPhone: "",
      rawTimezone: null,
    });
  });

  test("item missing the phone column entirely → phoneE164 null, rawPhone ''", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([{ id: "4", name: "Bare Item", column_values: [] }]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows[0]).toMatchObject({
      mondayItemId: "4",
      phoneE164: null,
      rawPhone: "",
    });
  });

  test("text-type phone column (no PhoneValue fields) falls back to the raw text string", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([
        {
          id: "5",
          name: "Tex Ted",
          column_values: [{ id: "text_col", text: "(555) 123-0002" }],
        },
      ]),
    );

    const rows = await fetchBoardRecipients("4567890123", "text_col");

    expect(rows).toEqual([
      {
        mondayItemId: "5",
        name: "Tex Ted",
        firstName: "Tex",
        phoneE164: "+15551230002",
        rawPhone: "(555) 123-0002",
        rawTimezone: null,
      },
    ]);
  });

  test("picks the phone column by id even when other column_values are present", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([
        {
          id: "6",
          name: "Multi Col",
          column_values: [
            { id: "other_col", text: "not a phone" },
            {
              id: "phone_col",
              text: "+1 555 123 0003",
              phone: "15551230003",
              country_short_name: "US",
            },
          ],
        },
      ]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows[0]).toMatchObject({ phoneE164: "+15551230003" });
  });

  test("board not found → empty list, no next_items_page call", async () => {
    h.mondayGraphQL.mockResolvedValueOnce({ boards: [] });

    await expect(
      fetchBoardRecipients("999", "phone_col"),
    ).resolves.toEqual([]);
    expect(h.mondayGraphQL).toHaveBeenCalledTimes(1);
  });
});

describe("fetchBoardRecipients — timezone column", () => {
  function firstPage(items: unknown[], cursor: string | null = null) {
    return { boards: [{ items_page: { cursor, items } }] };
  }

  /** An item with a phone cell plus a text-ish timezone cell. */
  function zonedItem(id: string, phone: string, tzText: string | null) {
    return {
      id,
      name: `Zoned ${id}`,
      column_values: [
        { id: "phone_col", text: phone, phone, country_short_name: "US" },
        { id: "tz_col", text: tzText },
      ],
    };
  }

  test("timezoneColumnId adds the column to $columnIds and fills rawTimezone verbatim", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([zonedItem("1", "15551230001", " ET ")]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col", "tz_col");

    const [, variables] = h.mondayGraphQL.mock.calls[0];
    expect(variables).toMatchObject({ columnIds: ["phone_col", "tz_col"] });
    // Trimmed but otherwise verbatim — normalization happens at campaign
    // creation (normalizeRecipientZone), never here.
    expect(rows[0]).toMatchObject({
      phoneE164: "+15551230001",
      rawTimezone: "ET",
    });
  });

  test("blank or missing timezone cell → rawTimezone null", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([
        zonedItem("1", "15551230001", ""),
        {
          id: "2",
          name: "No Tz Cell",
          column_values: [
            {
              id: "phone_col",
              text: "15551230002",
              phone: "15551230002",
              country_short_name: "US",
            },
          ],
        },
      ]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col", "tz_col");

    expect(rows[0].rawTimezone).toBeNull();
    expect(rows[1].rawTimezone).toBeNull();
  });

  test("no timezoneColumnId → only the phone column travels (unchanged shape)", async () => {
    h.mondayGraphQL.mockResolvedValueOnce(
      firstPage([zonedItem("1", "15551230001", "ET")]),
    );

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    const [, variables] = h.mondayGraphQL.mock.calls[0];
    expect(variables).toMatchObject({ columnIds: ["phone_col"] });
    // The tz cell is ignored when the list has no timezone column configured.
    expect(rows[0].rawTimezone).toBeNull();
  });

  test("cursor pages carry the same columnIds and map rawTimezone too", async () => {
    h.mondayGraphQL
      .mockResolvedValueOnce(
        firstPage([zonedItem("1", "15551230001", "ET")], "cursor-1"),
      )
      .mockResolvedValueOnce({
        next_items_page: {
          cursor: null,
          items: [zonedItem("2", "15551230002", "Pacific/Honolulu")],
        },
      });

    const rows = await fetchBoardRecipients("4567890123", "phone_col", "tz_col");

    expect(rows).toHaveLength(2);
    expect(rows[1].rawTimezone).toBe("Pacific/Honolulu");
    const [, v2] = h.mondayGraphQL.mock.calls[1];
    expect(v2).toMatchObject({
      cursor: "cursor-1",
      columnIds: ["phone_col", "tz_col"],
    });
  });
});

describe("fetchBoardRecipients — pagination", () => {
  test("walks items_page → next_items_page(cursor) across 3 pages (1100 items) until cursor is null", async () => {
    // 500 + 500 + 100 = 1100 items with unique, normalizable US phones.
    const allItems = Array.from({ length: 1100 }, (_, i) =>
      phoneItem(`item-${i + 1}`, `Patient ${i + 1}`, String(5550000000 + i + 1)),
    );
    const pages = [
      { cursor: "cursor-1", items: allItems.slice(0, 500) },
      { cursor: "cursor-2", items: allItems.slice(500, 1000) },
      { cursor: null, items: allItems.slice(1000) },
    ];

    h.mondayGraphQL.mockImplementation(async (query, variables) => {
      if (query.includes("next_items_page")) {
        const cursor = (variables as { cursor?: string }).cursor;
        if (cursor === "cursor-1") return { next_items_page: pages[1] };
        if (cursor === "cursor-2") return { next_items_page: pages[2] };
        throw new Error(`unexpected cursor: ${String(cursor)}`);
      }
      return { boards: [{ items_page: pages[0] }] };
    });

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows).toHaveLength(1100);
    // Order preserved across page boundaries.
    expect(rows[0].mondayItemId).toBe("item-1");
    expect(rows[499].mondayItemId).toBe("item-500");
    expect(rows[500].mondayItemId).toBe("item-501");
    expect(rows[1099].mondayItemId).toBe("item-1100");
    expect(rows[1099].phoneE164).toBe("+15550001100");

    // Exactly 3 requests: 1 first page + 2 cursor follow-ups.
    expect(h.mondayGraphQL).toHaveBeenCalledTimes(3);
    const [q1] = h.mondayGraphQL.mock.calls[0];
    expect(q1).toContain("items_page");
    expect(q1).not.toContain("next_items_page");
    const [q2, v2] = h.mondayGraphQL.mock.calls[1];
    expect(q2).toContain("next_items_page");
    expect(q2).toContain("limit: 500");
    expect(v2).toMatchObject({ cursor: "cursor-1" });
    const [q3, v3] = h.mondayGraphQL.mock.calls[2];
    expect(q3).toContain("next_items_page");
    expect(v3).toMatchObject({ cursor: "cursor-2" });
  });

  test("single page with a null cursor never calls next_items_page", async () => {
    h.mondayGraphQL.mockResolvedValueOnce({
      boards: [
        {
          items_page: {
            cursor: null,
            items: [phoneItem("1", "Only One", "15551230001")],
          },
        },
      ],
    });

    const rows = await fetchBoardRecipients("4567890123", "phone_col");

    expect(rows).toHaveLength(1);
    expect(h.mondayGraphQL).toHaveBeenCalledTimes(1);
  });
});
