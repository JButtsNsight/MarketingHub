// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn(), listPolicies: vi.fn() }));

vi.mock("./pgmeta", () => ({
  runQuery: h.runQuery,
  listPolicies: h.listPolicies,
}));

import {
  POLICY_TEMPLATES,
  alterPolicy,
  createPolicy,
  dropPolicy,
  listPolicies,
  renderPolicyTemplate,
} from "./policies";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

beforeEach(() => {
  h.runQuery.mockReset();
  h.listPolicies.mockReset();
});

describe("createPolicy", () => {
  test("builds quoted DDL with defaults + both expressions", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await createPolicy({
      schema: "marketinghub",
      table: "templates",
      name: "svc",
      roles: ["service_role"],
      using: "true",
      check: "true",
    });
    expect(lastSql()).toBe(
      `create policy "svc" on "marketinghub"."templates" as permissive for all to "service_role" using (true) with check (true)`,
    );
  });

  test("renders the public pseudo-role as a bare keyword, not a quoted role", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await createPolicy({
      schema: "public",
      table: "notes",
      name: "pub",
      command: "SELECT",
      roles: ["public"],
      using: "true",
    });
    expect(lastSql()).toBe(
      `create policy "pub" on "public"."notes" as permissive for select to public using (true)`,
    );
  });

  test("defaults to TO public when no roles are given", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await createPolicy({ schema: "public", table: "notes", name: "p", using: "true" });
    expect(lastSql()).toContain("to public");
  });

  test("fails loud when the target table is absent", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(
      createPolicy({ schema: "marketinghub", table: "ghost", name: "p", using: "true" }),
    ).rejects.toThrow(/table marketinghub\.ghost does not exist/);
  });

  test("rejects an unsafe policy name before touching the DB", async () => {
    await expect(
      createPolicy({ schema: "public", table: "notes", name: "p; drop table notes", using: "true" }),
    ).rejects.toThrow(/\[console:policies\] create-policy failed: invalid policy name/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("rejects an unsafe role name", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]);
    await expect(
      createPolicy({
        schema: "public",
        table: "notes",
        name: "p",
        roles: ["r; drop"],
        using: "true",
      }),
    ).rejects.toThrow(/invalid role/);
  });

  test("rejects an out-of-whitelist command", async () => {
    await expect(
      // @ts-expect-error deliberately invalid command
      createPolicy({ schema: "public", table: "notes", name: "p", command: "TRUNCATE" }),
    ).rejects.toThrow(/unsupported command/);
  });
});

describe("alterPolicy", () => {
  test("renames first, then updates clauses against the new name", async () => {
    h.runQuery
      .mockResolvedValueOnce([{ found: true }]) // exists
      .mockResolvedValueOnce([]) // rename
      .mockResolvedValueOnce([]); // clause update
    await alterPolicy({
      schema: "marketinghub",
      table: "templates",
      name: "old",
      newName: "new",
      roles: ["authenticated"],
      using: "user_id = (select auth.uid())",
    });
    expect(h.runQuery.mock.calls[1][0]).toBe(
      `alter policy "old" on "marketinghub"."templates" rename to "new"`,
    );
    expect(lastSql()).toBe(
      `alter policy "new" on "marketinghub"."templates" to "authenticated" using (user_id = (select auth.uid()))`,
    );
  });

  test("fails when nothing would change", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]);
    await expect(
      alterPolicy({ schema: "public", table: "notes", name: "p" }),
    ).rejects.toThrow(/no changes provided/);
  });

  test("fails loud when the policy is absent", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: false }]);
    await expect(
      alterPolicy({ schema: "public", table: "notes", name: "ghost", roles: ["anon"] }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("dropPolicy", () => {
  test("existence-checks then drops with quoted identifiers", async () => {
    h.runQuery.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);
    await dropPolicy("marketinghub", "templates", "svc");
    expect(lastSql()).toBe('drop policy "svc" on "marketinghub"."templates"');
  });

  test("rejects an unsafe identifier before any SQL runs", async () => {
    await expect(dropPolicy("public", "notes", "p; drop table notes")).rejects.toThrow(
      /invalid policy name/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("templates", () => {
  test("seed the three gate-satisfying patterns, each enabling RLS", () => {
    expect(POLICY_TEMPLATES.map((t) => t.id)).toEqual([
      "service_role_full_access",
      "owner_access_auth_uid",
      "public_read_only",
    ]);
    for (const t of POLICY_TEMPLATES) {
      expect(t.sql).toContain("enable row level security");
      expect(t.sql).toContain("{{table}}");
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test("renderPolicyTemplate substitutes a quoted qualified identifier", () => {
    const sql = renderPolicyTemplate("service_role_full_access", "marketinghub", "templates");
    expect(sql).toContain('on "marketinghub"."templates"');
    expect(sql).not.toContain("{{table}}");
  });

  test("renderPolicyTemplate rejects an unsafe identifier", () => {
    expect(() => renderPolicyTemplate("public_read_only", "marketinghub", "t; drop")).toThrow(
      /invalid table/,
    );
  });

  test("renderPolicyTemplate rejects an unknown template id", () => {
    expect(() => renderPolicyTemplate("nope", "public", "notes")).toThrow(
      /unknown policy template/,
    );
  });
});

describe("re-export", () => {
  test("listPolicies delegates to pg-meta", async () => {
    h.listPolicies.mockResolvedValue([{ name: "p" }]);
    const pols = await listPolicies(["public"]);
    expect(pols).toEqual([{ name: "p" }]);
    expect(h.listPolicies).toHaveBeenCalledWith(["public"]);
  });
});
