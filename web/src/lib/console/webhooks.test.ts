// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

// webhooks.ts pulls OBJECT_SCHEMAS from ./dbobjects, which itself imports
// ./pgmeta — so the mock must satisfy every named import dbobjects makes, even
// though the webhook tests only exercise runQuery.
const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  listColumns: vi.fn(),
  listExtensions: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock("./pgmeta", () => ({
  runQuery: h.runQuery,
  listColumns: h.listColumns,
  listExtensions: h.listExtensions,
  listTables: h.listTables,
}));

import { createWebhook, dropWebhook, listWebhooks } from "./webhooks";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("listWebhooks", () => {
  test("decodes events from tgtype and best-effort-parses url/method", async () => {
    h.runQuery.mockResolvedValue([
      {
        schema: "public",
        table: "notes",
        name: "notes_webhook",
        on_insert: true,
        on_update: false,
        on_delete: true,
        enabled: true,
        definition:
          "CREATE TRIGGER notes_webhook AFTER INSERT OR DELETE ON public.notes " +
          "FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request(" +
          `'https://example.com/hook', 'POST', '{"Content-Type":"application/json"}', '{}', '5000')`,
      },
    ]);
    const hooks = await listWebhooks();
    expect(hooks[0]).toMatchObject({
      schema: "public",
      table: "notes",
      name: "notes_webhook",
      events: ["insert", "delete"],
      enabled: true,
      url: "https://example.com/hook",
      method: "POST",
    });
  });

  test("filters to the supabase_functions.http_request convention", async () => {
    h.runQuery.mockResolvedValue([]);
    await listWebhooks();
    const sql = String(h.runQuery.mock.calls[0][0]);
    expect(sql).toContain("fn.nspname = 'supabase_functions'");
    expect(sql).toContain("fp.proname = 'http_request'");
  });
});

describe("createWebhook", () => {
  test("asserts role + fn + table, then builds the trigger DDL", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // webhooks_admin role
      .mockResolvedValueOnce([{ found: true }]) // http_request fn
      .mockResolvedValueOnce([{ found: true }]) // table exists
      .mockResolvedValueOnce([]); // create trigger
    await createWebhook({
      schema: "public",
      table: "notes",
      name: "hook",
      events: ["insert", "update"],
      url: "https://example.com/x",
      method: "POST",
    });
    expect(lastSql()).toBe(
      `create trigger "hook" after insert or update on "public"."notes" ` +
        `for each row execute function "supabase_functions"."http_request"(` +
        `'https://example.com/x', 'POST', '{"Content-Type":"application/json"}', '{}', '5000')`,
    );
  });

  test("is refused (with a pointer to the migration) when webhooks_admin is absent", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]); // role missing
    await expect(
      createWebhook({
        schema: "public",
        table: "notes",
        name: "hook",
        events: ["insert"],
        url: "https://example.com/x",
      }),
    ).rejects.toThrow(/webhooks_admin role does not exist/);
  });

  test("rejects a non-http url before any DB call", async () => {
    await expect(
      createWebhook({
        schema: "public",
        table: "notes",
        name: "hook",
        events: ["insert"],
        url: "ftp://evil.example.com",
      }),
    ).rejects.toThrow(/url must use http or https/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("refuses an unmanaged schema", async () => {
    await expect(
      createWebhook({
        schema: "auth",
        table: "users",
        name: "hook",
        events: ["insert"],
        url: "https://example.com/x",
      }),
    ).rejects.toThrow(/schema not managed here/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("requires at least one event", async () => {
    await expect(
      createWebhook({
        schema: "public",
        table: "notes",
        name: "hook",
        events: [],
        url: "https://example.com/x",
      }),
    ).rejects.toThrow(/at least one event/);
  });
});

describe("dropWebhook", () => {
  test("drops only a confirmed webhook trigger", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropWebhook("public", "notes", "hook");
    expect(lastSql()).toBe('drop trigger "hook" on "public"."notes"');
  });

  test("fails when the trigger is not a webhook trigger", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(dropWebhook("public", "notes", "plain_trigger")).rejects.toThrow(
      /does not exist/,
    );
  });

  test("rejects an unsafe identifier before any SQL runs", async () => {
    await expect(dropWebhook("public", "notes", "x; drop table notes")).rejects.toThrow(
      /invalid webhook name/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});
