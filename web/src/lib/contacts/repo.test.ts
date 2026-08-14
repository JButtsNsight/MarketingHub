// @vitest-environment node
// Repo over a mocked PostgREST client — node env matches the other repo suites.
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mutable holder so each test can swap in a fresh mock client.
const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import type { ParsedContact } from "./csv";
import { createCsvList, createMondayList } from "./repo";

interface Calls {
  schema: string | null;
  tables: string[];
  listInserts: Array<Record<string, unknown>>;
  memberChunks: Array<Array<Record<string, unknown>>>;
  updates: Array<Record<string, unknown>>;
  uploads: Array<{ bucket: string; path: string }>;
  deletes: number;
}

/**
 * Fake covering exactly the chains the repo uses: contact_lists
 * insert/update/delete, chunked contact_list_members inserts, and the
 * storage upload. Happy-path only — error paths are covered per-call.
 */
function buildClient() {
  const calls: Calls = {
    schema: null,
    tables: [],
    listInserts: [],
    memberChunks: [],
    updates: [],
    uploads: [],
    deletes: 0,
  };

  const listRow = {
    id: "list-1",
    created_at: "2026-08-11T00:00:00Z",
    updated_at: "2026-08-11T00:00:00Z",
  };

  const listsQ = {
    insert(row: Record<string, unknown>) {
      calls.listInserts.push(row);
      return {
        select: () => ({
          single: async () => ({ data: { ...listRow, ...row }, error: null }),
        }),
      };
    },
    update(patch: Record<string, unknown>) {
      calls.updates.push(patch);
      return {
        eq: () => ({
          select: () => ({
            single: async () => ({
              data: { ...listRow, ...patch },
              error: null,
            }),
          }),
        }),
      };
    },
    delete() {
      calls.deletes++;
      return { eq: async () => ({ error: null }) };
    },
  };

  const membersQ = {
    // `await members(db).insert(chunk)` — a plain result object awaits fine.
    insert: async (chunk: Array<Record<string, unknown>>) => {
      calls.memberChunks.push(chunk);
      return { error: null };
    },
  };

  const client = {
    schema(s: string) {
      calls.schema = s;
      return {
        from(t: string) {
          calls.tables.push(t);
          return t === "contact_lists" ? listsQ : membersQ;
        },
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          calls.uploads.push({ bucket, path });
          return { error: null };
        },
      }),
    },
  };

  return { client, calls };
}

const file = { filename: "patients.csv", content: "name,phone\n..." };
const creator = { email: "amy@nsight.example" };

function okContact(overrides: Partial<ParsedContact> = {}): ParsedContact {
  return {
    name: "Jane Doe",
    firstName: "Jane",
    phoneE164: "+15559234567",
    rawPhone: "(555) 923-4567",
    reason: "ok",
    ...overrides,
  };
}

describe("createCsvList — member timezone stored VERBATIM", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("stores the raw cell value untouched; absent/blank → null (audit record — normalization is campaign-time)", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    const list = await createCsvList(
      "August recall",
      [
        okContact({ timezone: "et" }),
        okContact({
          phoneE164: "+15559234568",
          rawPhone: "5559234568",
          timezone: "America/Chicago",
        }),
        // Unknown zone: the row STAYS, and the raw value SURVIVES — the
        // campaign route normalizes (fallback + per-row note); destroying it
        // here would make an ignored value indistinguishable from a blank.
        okContact({
          phoneE164: "+15559234569",
          rawPhone: "5559234569",
          timezone: "EST",
        }),
        // No timezone column on the sheet at all.
        okContact({ phoneE164: "+15559234570", rawPhone: "5559234570" }),
      ],
      file,
      creator,
    );

    expect(list.id).toBe("list-1");
    expect(calls.schema).toBe("marketinghub");
    expect(calls.memberChunks).toHaveLength(1);
    const rows = calls.memberChunks[0];
    expect(rows.map((r) => r.timezone)).toEqual([
      "et",
      "America/Chicago",
      "EST",
      null,
    ]);
    // Full row shape stays intact around the new column.
    expect(rows[0]).toMatchObject({
      list_id: "list-1",
      name: "Jane Doe",
      first_name: "Jane",
      phone_e164: "+15559234567",
      raw_phone: "(555) 923-4567",
      reason: "ok",
      consent_source: null,
      consent_date: null,
    });
  });

  test("duplicate/invalid rows keep their verbatim zone and null phone", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    await createCsvList(
      "August recall",
      [
        okContact({ timezone: "ET" }),
        okContact({ phoneE164: null, reason: "duplicate", timezone: "CT" }),
        okContact({
          phoneE164: null,
          rawPhone: "123",
          reason: "invalid",
          timezone: "pt",
        }),
      ],
      file,
      creator,
    );

    const rows = calls.memberChunks[0];
    expect(rows[1]).toMatchObject({
      phone_e164: null,
      reason: "duplicate",
      timezone: "CT",
    });
    expect(rows[2]).toMatchObject({
      phone_e164: null,
      reason: "invalid",
      timezone: "pt",
    });
  });
});

describe("createCsvList — member email persisted", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("stores the email verbatim; absent/blank → '' (column NOT NULL DEFAULT '')", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    await createCsvList(
      "August recall",
      [
        okContact({ email: "jane@example.com", emailValid: true }),
        // Junk email is stored verbatim too — validity is parse-time only.
        okContact({
          phoneE164: "+15559234568",
          rawPhone: "5559234568",
          email: "not-an-email",
          emailValid: false,
        }),
        // Blank cell (parser gave null) and no email column at all (key
        // absent) both persist as ''.
        okContact({
          phoneE164: "+15559234569",
          rawPhone: "5559234569",
          email: null,
          emailValid: false,
        }),
        okContact({ phoneE164: "+15559234570", rawPhone: "5559234570" }),
      ],
      file,
      creator,
    );

    const rows = calls.memberChunks[0];
    expect(rows.map((r) => r.email)).toEqual([
      "jane@example.com",
      "not-an-email",
      "",
      "",
    ]);
  });

  test("a valid-email row with an unusable phone is stored unchanged: reason invalid, null phone", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    await createCsvList(
      "August recall",
      [
        okContact({ email: "jane@example.com", emailValid: true }),
        okContact({
          phoneE164: null,
          rawPhone: "123",
          reason: "invalid",
          email: "reachable@example.com",
          emailValid: true,
        }),
      ],
      file,
      creator,
    );

    const rows = calls.memberChunks[0];
    // Stored exactly like today's invalid rows (kept for audit) — the email
    // rides along; the SMS send path (reason = 'ok') still never sees it.
    expect(rows[1]).toMatchObject({
      phone_e164: null,
      raw_phone: "123",
      reason: "invalid",
      email: "reachable@example.com",
    });
    // Regression: the pre-email row shape is intact around the new column.
    expect(rows[0]).toMatchObject({
      list_id: "list-1",
      name: "Jane Doe",
      first_name: "Jane",
      phone_e164: "+15559234567",
      raw_phone: "(555) 923-4567",
      reason: "ok",
      consent_source: null,
      consent_date: null,
      timezone: null,
      email: "jane@example.com",
    });
  });
});

describe("createMondayList — optional timezone/outcome columns", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("persists monday_timezone_column_id + monday_outcome_column_id when picked", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    const list = await createMondayList(
      "Patient board",
      {
        id: "123456",
        name: "Patients",
        phoneColumnId: "phone_col",
        timezoneColumnId: "tz_col",
        outcomeColumnId: "status_col",
      },
      creator,
    );

    expect(list.id).toBe("list-1");
    expect(calls.listInserts[0]).toMatchObject({
      source: "monday",
      monday_board_id: "123456",
      monday_phone_column_id: "phone_col",
      monday_timezone_column_id: "tz_col",
      monday_outcome_column_id: "status_col",
      created_by: "amy@nsight.example",
    });
  });

  test("omitted pickers persist as null (zoneless lists behave exactly as today)", async () => {
    const { client, calls } = buildClient();
    h.client = client;

    await createMondayList(
      "Patient board",
      { id: "123456", name: "Patients", phoneColumnId: "phone_col" },
      creator,
    );

    expect(calls.listInserts[0]).toMatchObject({
      monday_timezone_column_id: null,
      monday_outcome_column_id: null,
    });
  });
});
