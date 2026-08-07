// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  listExtensions: vi.fn(),
}));

vi.mock("./pgmeta", () => ({
  runQuery: h.runQuery,
  listExtensions: h.listExtensions,
}));

import {
  addEnumValue,
  dropExtension,
  dropFunction,
  dropIndex,
  dropPublication,
  dropTrigger,
  enableExtension,
  listFunctions,
  listRoles,
  setTriggerEnabled,
} from "./dbobjects";

/** The SQL of the last runQuery call. */
function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  h.runQuery.mockReset();
  h.listExtensions.mockReset();
});

describe("readers", () => {
  test("listRoles maps catalog booleans to a typed shape", async () => {
    h.runQuery.mockResolvedValue([
      {
        name: "service_role",
        is_superuser: false,
        can_login: true,
        can_create_role: false,
        can_create_db: false,
        is_replication: false,
        bypass_rls: true,
        connection_limit: -1,
        valid_until: null,
      },
    ]);
    const roles = await listRoles();
    expect(roles[0]).toEqual({
      name: "service_role",
      isSuperuser: false,
      canLogin: true,
      canCreateRole: false,
      canCreateDb: false,
      isReplication: false,
      bypassRls: true,
      connectionLimit: -1,
      validUntil: null,
    });
  });

  test("listFunctions coerces the oid to a number", async () => {
    h.runQuery.mockResolvedValue([
      {
        oid: "16480",
        schema: "marketinghub",
        name: "claim_due_sms_recipients",
        identity_arguments: "integer",
        arguments: "batch integer",
        return_type: "SETOF record",
        language: "plpgsql",
        kind: "function",
        security_definer: true,
      },
    ]);
    const fns = await listFunctions();
    expect(fns[0].oid).toBe(16480);
    expect(fns[0].securityDefiner).toBe(true);
    expect(String(h.runQuery.mock.calls[0][0])).toContain(
      "n.nspname in ('public', 'marketinghub', 'storage')",
    );
  });
});

describe("dropFunction", () => {
  test("keys off the numeric oid — no caller identifier reaches SQL", async () => {
    h.runQuery.mockResolvedValue([]);
    await dropFunction(16480);
    const sql = lastSql();
    expect(sql).toContain("p.oid = 16480");
    expect(sql).toContain("oid::regprocedure::text");
  });

  test("rejects a non-integer oid", async () => {
    await expect(dropFunction(1.5)).rejects.toThrow(/invalid function oid/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("dropIndex", () => {
  test("rejects an unsafe identifier before any SQL runs", async () => {
    await expect(dropIndex("public", "x; drop table users")).rejects.toThrow(
      /\[console:dbobjects\] drop-index failed: invalid index/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("fails loud when the index does not exist", async () => {
    h.runQuery.mockResolvedValueOnce([]);
    await expect(dropIndex("public", "nope")).rejects.toThrow(/does not exist/);
  });

  test("refuses to drop a primary-key index", async () => {
    h.runQuery.mockResolvedValueOnce([{ is_primary: true }]);
    await expect(dropIndex("marketinghub", "templates_pkey")).rejects.toThrow(
      /backs a primary key/,
    );
  });

  test("drops a real, non-PK index with quoted identifiers", async () => {
    h.runQuery.mockResolvedValueOnce([{ is_primary: false }]).mockResolvedValueOnce([]);
    await dropIndex("marketinghub", "templates_name_idx");
    expect(lastSql()).toBe('drop index "marketinghub"."templates_name_idx"');
  });
});

describe("triggers", () => {
  test("dropTrigger existence-checks then drops with quoted identifiers", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropTrigger("marketinghub", "sms_campaigns", "set_updated_at");
    expect(lastSql()).toBe(
      'drop trigger "set_updated_at" on "marketinghub"."sms_campaigns"',
    );
  });

  test("dropTrigger fails when the trigger is absent", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(dropTrigger("marketinghub", "t", "nope")).rejects.toThrow(
      /does not exist/,
    );
  });

  test("setTriggerEnabled toggles enable/disable", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await setTriggerEnabled("marketinghub", "sms_campaigns", "audit", false);
    expect(lastSql()).toBe(
      'alter table "marketinghub"."sms_campaigns" disable trigger "audit"',
    );
  });
});

describe("addEnumValue", () => {
  test("appends a literal value to an existing enum type", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await addEnumValue("marketinghub", "campaign_status", "paused");
    expect(lastSql()).toBe(
      `alter type "marketinghub"."campaign_status" add value if not exists 'paused'`,
    );
  });

  test("escapes a quote in the enum value", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await addEnumValue("marketinghub", "s", "o'k");
    expect(lastSql()).toContain("add value if not exists 'o''k'");
  });
});

describe("dropPublication", () => {
  test("existence-checks then drops", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropPublication("supabase_realtime");
    expect(lastSql()).toBe('drop publication "supabase_realtime"');
  });
});

describe("extensions", () => {
  test("enableExtension only accepts a name pg-meta knows, with quoted schema/version", async () => {
    h.listExtensions.mockResolvedValue([
      { name: "vector", schema: null, default_version: "0.8.0", installed_version: null, comment: null },
    ]);
    h.runQuery.mockResolvedValue([]);
    await enableExtension("vector", { schema: "extensions", version: "0.8.0" });
    expect(lastSql()).toBe(
      `create extension if not exists "vector" with schema "extensions" version '0.8.0'`,
    );
  });

  test("enableExtension refuses an unknown extension name", async () => {
    h.listExtensions.mockResolvedValue([]);
    await expect(enableExtension("totally_made_up")).rejects.toThrow(
      /unknown extension/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("dropExtension refuses one that is not installed", async () => {
    h.listExtensions.mockResolvedValue([
      { name: "pgaudit", schema: null, default_version: "1.7", installed_version: null, comment: null },
    ]);
    await expect(dropExtension("pgaudit")).rejects.toThrow(/not installed/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("dropExtension drops an installed one", async () => {
    h.listExtensions.mockResolvedValue([
      { name: "pgaudit", schema: null, default_version: "1.7", installed_version: "1.7", comment: null },
    ]);
    h.runQuery.mockResolvedValue([]);
    await dropExtension("pgaudit");
    expect(lastSql()).toBe('drop extension "pgaudit"');
  });
});
