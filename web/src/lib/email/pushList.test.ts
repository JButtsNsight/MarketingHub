// @vitest-environment node
// Helper over a mocked PostgREST client — node env matches the repo suites.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PUSH_LIST_CAP, loadPushableLeads } from "./pushList";

const LIST_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

interface Calls {
  schema: string | null;
  table: string | null;
  eq: [string, string] | null;
  ranges: Array<[number, number]>;
}

/** Fake covering exactly the chain the helper uses; rows served by index. */
function fakeDb(rowAt: (i: number) => Record<string, unknown> | null) {
  const calls: Calls = { schema: null, table: null, eq: null, ranges: [] };
  const db = {
    schema(s: string) {
      calls.schema = s;
      return {
        from(t: string) {
          calls.table = t;
          return {
            select: () => ({
              eq: (col: string, val: string) => {
                calls.eq = [col, val];
                return {
                  order: () => ({
                    range: async (from: number, to: number) => {
                      calls.ranges.push([from, to]);
                      const rows: Record<string, unknown>[] = [];
                      for (let i = from; i <= to; i++) {
                        const row = rowAt(i);
                        if (!row) break;
                        rows.push(row);
                      }
                      return { data: rows, error: null };
                    },
                  }),
                };
              },
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

/** Fixed-array convenience over fakeDb. */
function fakeDbRows(rows: Array<Record<string, unknown>>) {
  return fakeDb((i) => rows[i] ?? null);
}

describe("loadPushableLeads", () => {
  it("keeps plausible emails, splits names, and counts the rest as skipped", async () => {
    const { db, calls } = fakeDbRows([
      // first_name wins; last name = the remainder of the full name.
      { email: "ada@ex.com", name: "Ada Lovelace", first_name: "Ada" },
      // No first_name: first token of name, rest becomes the last name.
      { email: "grace@navy.mil", name: "Grace Brewster Hopper", first_name: "" },
      // Whitespace trims; a name-less row still pushes (email only).
      { email: "  lone@ex.com  ", name: "", first_name: "" },
      { email: "", name: "No Email", first_name: "No" },
      { email: "not-an-email", name: "Bad Cell", first_name: "" },
      { email: "missing@dot", name: "No Dot", first_name: "" },
      // Pre-migration row without the email column coerces to no-email.
      { name: "Legacy Row", first_name: "" },
    ]);
    const out = await loadPushableLeads(LIST_ID, db);
    expect(out).toEqual({
      leads: [
        { email: "ada@ex.com", firstName: "Ada", lastName: "Lovelace" },
        {
          email: "grace@navy.mil",
          firstName: "Grace",
          lastName: "Brewster Hopper",
        },
        { email: "lone@ex.com" },
      ],
      skipped: 4,
      overCap: false,
    });
    expect(calls.schema).toBe("marketinghub");
    expect(calls.table).toBe("contact_list_members");
    expect(calls.eq).toEqual(["list_id", LIST_ID]);
  });

  it("dedupes repeated emails case-insensitively, counting dups as skipped", async () => {
    const { db } = fakeDbRows([
      { email: "ada@ex.com", name: "Ada Lovelace", first_name: "Ada" },
      { email: "ADA@ex.com", name: "Ada Duplicate", first_name: "" },
      { email: "grace@navy.mil", name: "", first_name: "" },
    ]);
    const out = await loadPushableLeads(LIST_ID, db);
    expect(out.leads.map((l) => l.email)).toEqual([
      "ada@ex.com",
      "grace@navy.mil",
    ]);
    expect(out.skipped).toBe(1);
  });

  it("splits names only at a word boundary (a prefix first_name never bisects)", async () => {
    const { db } = fakeDbRows([
      // "Jo" prefixes "John" but is not the first word — remainder must be
      // "Smith", never "hn Smith".
      { email: "jo@ex.com", name: "John Smith", first_name: "Jo" },
      // Exact first-word match still strips cleanly.
      { email: "john@ex.com", name: "John Smith", first_name: "John" },
    ]);
    const out = await loadPushableLeads(LIST_ID, db);
    expect(out.leads).toEqual([
      { email: "jo@ex.com", firstName: "Jo", lastName: "Smith" },
      { email: "john@ex.com", firstName: "John", lastName: "Smith" },
    ]);
  });

  it("pages in 1000s until a short page", async () => {
    const { db, calls } = fakeDb((i) =>
      i < 1500 ? { email: `u${i}@ex.com`, name: `U ${i}`, first_name: "" } : null,
    );
    const out = await loadPushableLeads(LIST_ID, db);
    expect(out.leads).toHaveLength(1500);
    expect(out.skipped).toBe(0);
    expect(out.overCap).toBe(false);
    expect(calls.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("allows exactly the cap, refuses one past it, and stops fetching early", async () => {
    const row = (i: number) => ({
      email: `u${i}@ex.com`,
      name: "",
      first_name: "",
    });
    const atCap = await loadPushableLeads(
      LIST_ID,
      fakeDb((i) => (i < PUSH_LIST_CAP ? row(i) : null)).db,
    );
    expect(atCap.overCap).toBe(false);
    expect(atCap.leads).toHaveLength(PUSH_LIST_CAP);

    // 20k rows: the 10,001st usable email trips the cap mid-page-11 — the
    // remaining 9 pages are never fetched.
    const big = fakeDb((i) => (i < 20_000 ? row(i) : null));
    const over = await loadPushableLeads(LIST_ID, big.db);
    expect(over.overCap).toBe(true);
    expect(big.calls.ranges).toHaveLength(11);
  });

  it("fails loud on a PostgREST error", async () => {
    const db = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              order: () => ({
                range: async () => ({ data: null, error: { message: "boom" } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    await expect(loadPushableLeads(LIST_ID, db)).rejects.toThrow(
      /load-members failed: boom/,
    );
  });
});
