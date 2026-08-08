// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  runQuery: vi.fn(),
  listExtensions: vi.fn(),
  listColumns: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock("./pgmeta", () => ({
  runQuery: h.runQuery,
  listExtensions: h.listExtensions,
  listColumns: h.listColumns,
  listTables: h.listTables,
}));

import {
  addEnumValue,
  alterPublication,
  alterRole,
  createEnumType,
  createIndex,
  createPublication,
  createRole,
  dropEnumType,
  dropExtension,
  dropFunction,
  dropIndex,
  dropPublication,
  dropRole,
  dropTrigger,
  enableExtension,
  getFunctionDefinition,
  listFunctions,
  listIndexesWithStats,
  listPublicationTables,
  listRoleMemberships,
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
  h.listColumns.mockReset();
  h.listTables.mockReset();
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

describe("role memberships", () => {
  test("listRoleMemberships maps pg_auth_members to a typed shape", async () => {
    h.runQuery.mockResolvedValue([
      { role: "authenticator", member: "anon", admin_option: false, grantor: "supabase_admin" },
    ]);
    const rows = await listRoleMemberships();
    expect(rows[0]).toEqual({
      role: "authenticator",
      member: "anon",
      adminOption: false,
      grantor: "supabase_admin",
    });
  });
});

describe("createRole", () => {
  test("creates with the WITH option words for the given attributes", async () => {
    h.runQuery.mockResolvedValue([]);
    await createRole("app_reader", { canLogin: true, connectionLimit: 5 });
    expect(lastSql()).toBe('create role "app_reader" with LOGIN CONNECTION LIMIT 5');
  });

  test("passwords reach SQL only as a literal", async () => {
    h.runQuery.mockResolvedValue([]);
    await createRole("app_reader", { password: "s3cr3t" });
    expect(lastSql()).toBe(`create role "app_reader" with PASSWORD 's3cr3t'`);
  });

  test("rejects an unsafe role name before any SQL runs", async () => {
    await expect(createRole("x; drop role postgres", {})).rejects.toThrow(
      /\[console:dbobjects\] create-role failed: invalid role name/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("alterRole", () => {
  test("refuses a protected platform role", async () => {
    await expect(alterRole("service_role", { canLogin: false })).rejects.toThrow(
      /protected platform role/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("refuses pg_* predefined roles", async () => {
    await expect(alterRole("pg_read_all_data", { bypassRls: true })).rejects.toThrow(
      /protected platform role/,
    );
  });

  test("existence-checks then alters with quoted identifier", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await alterRole("app_reader", { canLogin: false, bypassRls: true });
    expect(lastSql()).toBe('alter role "app_reader" with NOLOGIN BYPASSRLS');
  });

  test("fails when there is nothing to change", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]);
    await expect(alterRole("app_reader", {})).rejects.toThrow(/no attributes/);
  });
});

describe("dropRole", () => {
  test("refuses a protected role", async () => {
    await expect(dropRole("postgres")).rejects.toThrow(/refusing to drop/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("existence-checks then drops", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropRole("app_reader");
    expect(lastSql()).toBe('drop role "app_reader"');
  });

  test("fails loud when the role is absent", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(dropRole("ghost")).rejects.toThrow(/does not exist/);
  });
});

describe("getFunctionDefinition", () => {
  test("returns null when the oid is unknown", async () => {
    h.runQuery.mockResolvedValue([]);
    expect(await getFunctionDefinition(999999)).toBeNull();
  });

  test("returns the definition + kind for a real oid", async () => {
    h.runQuery.mockResolvedValue([
      { definition: "CREATE FUNCTION f() ...", kind: "function" },
    ]);
    const def = await getFunctionDefinition(16480);
    expect(def).toEqual({ definition: "CREATE FUNCTION f() ...", kind: "function" });
    expect(lastSql()).toContain("p.oid = 16480");
  });

  test("rejects a non-integer oid", async () => {
    await expect(getFunctionDefinition(1.5)).rejects.toThrow(/invalid function oid/);
  });
});

describe("createIndex (structured)", () => {
  test("existence-checks table + columns, then builds quoted DDL", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "name" },
      { schema: "marketinghub", table: "templates", name: "id" },
    ]);
    h.runQuery.mockResolvedValue([]);
    await createIndex({
      schema: "marketinghub",
      table: "templates",
      name: "templates_name_idx",
      columns: ["name"],
      unique: false,
      method: "btree",
    });
    expect(lastSql()).toBe(
      'create index "templates_name_idx" on "marketinghub"."templates" using btree ("name")',
    );
  });

  test("rejects a schema that is not managed here", async () => {
    await expect(
      createIndex({
        schema: "auth",
        table: "users",
        name: "x",
        columns: ["id"],
        unique: false,
        method: "btree",
      }),
    ).rejects.toThrow(/schema not managed here/);
    expect(h.listColumns).not.toHaveBeenCalled();
  });

  test("rejects an unknown column against live introspection", async () => {
    h.listColumns.mockResolvedValue([
      { schema: "marketinghub", table: "templates", name: "name" },
    ]);
    await expect(
      createIndex({
        schema: "marketinghub",
        table: "templates",
        name: "x",
        columns: ["nope"],
        unique: false,
        method: "btree",
      }),
    ).rejects.toThrow(/unknown column: marketinghub\.templates\.nope/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("rejects an out-of-whitelist method", async () => {
    await expect(
      createIndex({
        schema: "marketinghub",
        table: "templates",
        name: "x",
        columns: ["name"],
        unique: false,
        // @ts-expect-error deliberately invalid method
        method: "bloom",
      }),
    ).rejects.toThrow(/unsupported index method/);
  });
});

describe("listIndexesWithStats", () => {
  test("merges idx_scan by (schema, table, name)", async () => {
    h.runQuery
      .mockResolvedValueOnce([
        {
          schema: "marketinghub",
          table: "templates",
          name: "templates_name_idx",
          is_unique: false,
          is_primary: false,
          definition: "CREATE INDEX ...",
          bytes: 8192,
        },
      ])
      .mockResolvedValueOnce([
        {
          schema: "marketinghub",
          table: "templates",
          name: "templates_name_idx",
          idx_scan: 42,
        },
      ]);
    const rows = await listIndexesWithStats(["marketinghub"]);
    expect(rows[0].idxScan).toBe(42);
    expect(rows[0].name).toBe("templates_name_idx");
  });
});

describe("createEnumType / dropEnumType", () => {
  test("createEnumType checks schema + absence, then emits quoted DDL", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // schema exists
      .mockResolvedValueOnce([{ found: false }]) // type does not yet exist
      .mockResolvedValueOnce([]); // create
    await createEnumType("marketinghub", "status", ["active", "paused"]);
    expect(lastSql()).toBe(
      `create type "marketinghub"."status" as enum ('active', 'paused')`,
    );
  });

  test("createEnumType refuses a duplicate type", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }])
      .mockResolvedValueOnce([{ found: true }]);
    await expect(createEnumType("marketinghub", "status", ["a"])).rejects.toThrow(
      /already exists/,
    );
  });

  test("dropEnumType existence-checks then drops", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropEnumType("marketinghub", "status");
    expect(lastSql()).toBe('drop type "marketinghub"."status"');
  });
});

describe("publications (structured create/alter)", () => {
  test("createPublication for all tables uses a fixed publish clause", async () => {
    h.runQuery.mockResolvedValue([]);
    await createPublication({
      name: "everything",
      allTables: true,
      tables: [],
      publish: { insert: true, update: false, delete: false, truncate: false },
    });
    expect(lastSql()).toBe(
      `create publication "everything" for all tables with (publish = 'insert')`,
    );
  });

  test("createPublication existence-checks named tables against live introspection", async () => {
    h.listTables.mockResolvedValue([{ schema: "marketinghub", name: "templates" }]);
    h.runQuery.mockResolvedValue([]);
    await createPublication({
      name: "p",
      allTables: false,
      tables: [{ schema: "marketinghub", table: "templates" }],
      publish: { insert: true, update: true, delete: false, truncate: false },
    });
    expect(lastSql()).toBe(
      `create publication "p" for table "marketinghub"."templates" with (publish = 'insert, update')`,
    );
  });

  test("createPublication rejects an unknown table", async () => {
    h.listTables.mockResolvedValue([{ schema: "marketinghub", name: "templates" }]);
    await expect(
      createPublication({
        name: "p",
        allTables: false,
        tables: [{ schema: "marketinghub", table: "ghost" }],
        publish: { insert: true, update: false, delete: false, truncate: false },
      }),
    ).rejects.toThrow(/unknown table: marketinghub\.ghost/);
  });

  test("createPublication requires at least one publish op", async () => {
    await expect(
      createPublication({
        name: "p",
        allTables: true,
        tables: [],
        publish: { insert: false, update: false, delete: false, truncate: false },
      }),
    ).rejects.toThrow(/at least one publish operation/);
  });

  test("alterPublication updates ops and replaces the member set", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ all_tables: false }]) // existence + all-tables probe
      .mockResolvedValueOnce([]); // combined alter
    h.listTables.mockResolvedValue([{ schema: "marketinghub", name: "templates" }]);
    await alterPublication({
      name: "p",
      publish: { insert: true, update: false, delete: false, truncate: false },
      tables: [{ schema: "marketinghub", table: "templates" }],
    });
    expect(lastSql()).toBe(
      `alter publication "p" set (publish = 'insert'); ` +
        `alter publication "p" set table "marketinghub"."templates"`,
    );
  });

  test("alterPublication refuses a member-set change on an all-tables publication", async () => {
    h.runQuery.mockResolvedValueOnce([{ all_tables: true }]);
    await expect(
      alterPublication({
        name: "p",
        publish: { insert: true, update: false, delete: false, truncate: false },
        tables: [{ schema: "marketinghub", table: "templates" }],
      }),
    ).rejects.toThrow(/all-tables publication/);
  });

  test("listPublicationTables groups member tables by publication", async () => {
    h.runQuery.mockResolvedValue([
      { pubname: "p", schemaname: "marketinghub", tablename: "templates" },
      { pubname: "p", schemaname: "public", tablename: "notes" },
    ]);
    const map = await listPublicationTables();
    expect(map.get("p")).toEqual(["marketinghub.templates", "public.notes"]);
  });
});
