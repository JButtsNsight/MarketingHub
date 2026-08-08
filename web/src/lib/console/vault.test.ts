// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn() }));

vi.mock("./pgmeta", () => ({ runQuery: h.runQuery }));

import {
  auditVaultAction,
  auditVaultActionOrThrow,
  createSecret,
  deleteSecret,
  listSecrets,
  MAX_VALUE_LEN,
  revealSecret,
  updateSecret,
} from "./vault";
import { READ_ONLY_TABLES, SENSITIVE_TABLES, isReadOnlyTable } from "./tables";

const ID = "3f2c8a1e-9b4d-4c6f-8a2b-1d5e7f9a0c3b";

function lastSql(): string {
  return String(h.runQuery.mock.calls.at(-1)?.[0] ?? "");
}

function allSql(): string[] {
  return h.runQuery.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("listSecrets — metadata only, never the decrypting view", () => {
  test("selects metadata columns from vault.secrets", async () => {
    h.runQuery.mockResolvedValue([
      {
        id: ID,
        name: "stripe_api_key",
        description: "billing",
        created_at: "2026-08-08 10:00:00+00",
        updated_at: "2026-08-08 11:00:00+00",
      },
      { id: "x", name: null, description: null, created_at: null, updated_at: null },
    ]);
    const secrets = await listSecrets();
    expect(secrets[0]).toEqual({
      id: ID,
      name: "stripe_api_key",
      description: "billing",
      createdAt: "2026-08-08 10:00:00+00",
      updatedAt: "2026-08-08 11:00:00+00",
    });
    expect(secrets[1].name).toBeNull();

    const sql = lastSql();
    expect(sql).toContain("from vault.secrets");
    // Reveal isolation: the list NEVER touches the decrypting view …
    expect(sql).not.toContain("decrypted");
    // … and NEVER selects the ciphertext column ("secret" alone, not "secrets").
    const selectList = sql.slice(0, sql.indexOf("from"));
    expect(selectList).not.toMatch(/\bsecret\b/);
    expect(selectList).not.toMatch(/\*/);
  });
});

describe("createSecret — hostile input cannot break the SQL", () => {
  test("routes through vault.create_secret with quoted literals", async () => {
    h.runQuery.mockResolvedValue([{ id: ID }]);
    const id = await createSecret({
      name: "stripe_api_key",
      description: "billing",
      value: "sk_live_abc",
    });
    expect(id).toBe(ID);
    expect(lastSql()).toBe(
      "select vault.create_secret('sk_live_abc', 'stripe_api_key', 'billing')::text as id",
    );
  });

  test("hostile name/description stay inert literals (quotes doubled)", async () => {
    h.runQuery.mockResolvedValue([{ id: ID }]);
    await createSecret({
      name: "x'); drop table vault.secrets; --",
      description: "'; delete from vault.secrets; --",
      value: "v",
    });
    expect(lastSql()).toBe(
      "select vault.create_secret('v', 'x''); drop table vault.secrets; --', '''; delete from vault.secrets; --')::text as id",
    );
  });

  test("backslash-bearing value uses the E'' form (no escape smuggling)", async () => {
    h.runQuery.mockResolvedValue([{ id: ID }]);
    await createSecret({ name: "n", value: "a\\'b" });
    expect(lastSql()).toBe(
      "select vault.create_secret(E'a\\\\''b', 'n', '')::text as id",
    );
  });

  test("rejects NUL bytes, empties, and oversized values before any SQL", async () => {
    await expect(
      createSecret({ name: "n", value: "a\u0000b" }),
    ).rejects.toThrow(/\[console:vault\] create failed: value must not contain NUL/);
    await expect(createSecret({ name: "", value: "v" })).rejects.toThrow(
      /\[console:vault\] create failed/,
    );
    await expect(createSecret({ name: "n", value: "" })).rejects.toThrow(
      /\[console:vault\] create failed/,
    );
    await expect(
      createSecret({ name: "n", value: "x".repeat(MAX_VALUE_LEN + 1) }),
    ).rejects.toThrow(/\[console:vault\] create failed/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("a failing query throws a SANITIZED error — never the value or SQL", async () => {
    const value = "sk_live_SUPERSECRET";
    h.runQuery.mockRejectedValue(
      new Error(
        `[console:pgmeta] query failed: 400: invalid input near '${value}'`,
      ),
    );
    let thrown: Error | null = null;
    try {
      await createSecret({ name: "n", value });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe("[console:vault] create failed");
    expect(thrown!.message).not.toContain(value);
    expect(thrown!.message).not.toContain("select");
  });
});

describe("updateSecret", () => {
  test("routes through vault.update_secret with the validated uuid", async () => {
    h.runQuery.mockResolvedValue([]);
    await updateSecret(ID, { name: "n", description: "d", value: "v2" });
    expect(lastSql()).toBe(
      `select vault.update_secret('${ID}'::uuid, 'v2', 'n', 'd', null)`,
    );
  });

  test("hostile id is rejected before any query runs", async () => {
    await expect(
      updateSecret("1' or '1'='1", { name: "n", description: "d", value: "v" }),
    ).rejects.toThrow(/\[console:vault\] update failed: secret id must be a uuid/);
    await expect(
      updateSecret(`${ID}'; drop table vault.secrets; --`, {
        name: "n",
        description: "d",
        value: "v",
      }),
    ).rejects.toThrow(/secret id must be a uuid/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("a failing query throws a SANITIZED error — never the value", async () => {
    h.runQuery.mockRejectedValue(new Error("detail: 'v2-secret'"));
    await expect(
      updateSecret(ID, { name: "n", description: "d", value: "v2-secret" }),
    ).rejects.toThrow(/^\[console:vault\] update failed$/);
  });
});

describe("deleteSecret", () => {
  test("deletes by validated id only", async () => {
    h.runQuery.mockResolvedValue([]);
    await deleteSecret(ID);
    expect(lastSql()).toBe(
      `delete from vault.secrets where id = '${ID}'::uuid`,
    );
  });

  test("hostile id is rejected before any query runs", async () => {
    await expect(deleteSecret("not-a-uuid")).rejects.toThrow(
      /secret id must be a uuid/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("revealSecret — the single deliberate plaintext path", () => {
  test("reads exactly one id-filtered row from the decrypted view", async () => {
    h.runQuery.mockResolvedValue([{ decrypted_secret: "sk_live_abc" }]);
    const value = await revealSecret(ID);
    expect(value).toBe("sk_live_abc");

    const sql = lastSql();
    expect(sql).toContain("from vault.decrypted_secrets");
    // Never an unfiltered scan: the id filter is mandatory.
    expect(sql).toContain(`where id = '${ID}'::uuid`);
    expect(sql).not.toMatch(/\*/);
  });

  test("hostile id never reaches the decrypting view", async () => {
    await expect(revealSecret("' or 1=1 --")).rejects.toThrow(
      /\[console:vault\] reveal failed: secret id must be a uuid/,
    );
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  test("unknown id → sanitized failure, no detail", async () => {
    h.runQuery.mockResolvedValue([]);
    await expect(revealSecret(ID)).rejects.toThrow(
      /^\[console:vault\] reveal failed$/,
    );
  });

  test("a failing query throws a SANITIZED error — no SQL, no PG detail", async () => {
    h.runQuery.mockRejectedValue(
      new Error("[console:pgmeta] query failed: 400: decryption error in select …"),
    );
    let thrown: Error | null = null;
    try {
      await revealSecret(ID);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toBe("[console:vault] reveal failed");
    expect(thrown!.message).not.toContain("decrypted_secrets");
  });
});

describe("auditVaultAction — metadata only, best-effort, never throws", () => {
  test("inserts the metadata row (id, name, actor, action — no value column)", async () => {
    h.runQuery.mockResolvedValue([]);
    await auditVaultAction({
      secretId: ID,
      secretName: "stripe_api_key",
      actor: "justin@nsight.com",
      action: "reveal",
    });
    expect(lastSql()).toContain("insert into marketinghub.vault_console_audit");
    expect(lastSql()).toContain("(secret_id, secret_name, actor, action)");
    expect(lastSql()).toContain(
      `values ('${ID}'::uuid, 'stripe_api_key', 'justin@nsight.com', 'reveal')`,
    );
  });

  test("hostile name/actor stay inert literals; bad uuid becomes null", async () => {
    h.runQuery.mockResolvedValue([]);
    await auditVaultAction({
      secretId: "not-a-uuid'; --",
      secretName: "x'); drop table marketinghub.vault_console_audit; --",
      actor: "eve','reveal'); --",
      action: "delete",
    });
    const sql = lastSql();
    expect(sql).toContain("values (null, ");
    expect(sql).toContain("'x''); drop table marketinghub.vault_console_audit; --'");
    expect(sql).toContain("'eve'',''reveal''); --'");
  });

  test("never throws when the insert fails — but logs ONE constant string (no error detail)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.runQuery.mockRejectedValue(
      new Error("relation does not exist: near 'sk_live_SUPERSECRET'"),
    );
    await expect(
      auditVaultAction({ secretId: ID, secretName: "n", actor: "a", action: "create" }),
    ).resolves.toBeUndefined();
    // The failure is VISIBLE (a permanently broken audit table must not be
    // silent) but the log line carries zero request/error data.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("audit insert failed");
    expect(logged).not.toContain("sk_live_SUPERSECRET");
    expect(logged).not.toContain("relation");
    errorSpy.mockRestore();
  });

  test("skips silently on an invalid action (CHECK would reject it anyway)", async () => {
    await auditVaultAction({
      secretId: ID,
      secretName: "n",
      actor: "a",
      // @ts-expect-error — hostile caller
      action: "read'); --",
    });
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("auditVaultActionOrThrow — the reveal path's FAIL-CLOSED audit", () => {
  test("inserts the identical metadata row (id, name, actor, action)", async () => {
    h.runQuery.mockResolvedValue([]);
    await auditVaultActionOrThrow({
      secretId: ID,
      secretName: "stripe_api_key",
      actor: "justin@nsight.com",
      action: "reveal",
    });
    expect(lastSql()).toContain("insert into marketinghub.vault_console_audit");
    expect(lastSql()).toContain("(secret_id, secret_name, actor, action)");
    expect(lastSql()).toContain(
      `values ('${ID}'::uuid, 'stripe_api_key', 'justin@nsight.com', 'reveal')`,
    );
  });

  test("a failed insert THROWS sanitized — no SQL, no PG detail, no input echo", async () => {
    h.runQuery.mockRejectedValue(
      new Error(
        '[console:pgmeta] query failed: 400: relation "marketinghub.vault_console_audit" does not exist',
      ),
    );
    let thrown: Error | null = null;
    try {
      await auditVaultActionOrThrow({
        secretId: ID,
        secretName: "stripe_api_key",
        actor: "justin@nsight.com",
        action: "reveal",
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe(
      "[console:vault] reveal failed: the audit log is unavailable — refusing an unaudited reveal",
    );
    expect(thrown!.message).not.toContain("does not exist");
    expect(thrown!.message).not.toContain("insert");
  });

  test("an unwritable row (empty actor / bad action) also throws — never a silent skip", async () => {
    await expect(
      auditVaultActionOrThrow({
        secretId: ID,
        secretName: "n",
        actor: "",
        action: "reveal",
      }),
    ).rejects.toThrow(/\[console:vault\] reveal failed: audit row rejected/);
    expect(h.runQuery).not.toHaveBeenCalled();
  });
});

describe("reveal isolation across the module", () => {
  test("only revealSecret ever touches vault.decrypted_secrets", async () => {
    h.runQuery.mockResolvedValue([{ id: ID, decrypted_secret: "v" }]);
    await listSecrets();
    await deleteSecret(ID);
    await auditVaultAction({ secretId: ID, secretName: "n", actor: "a", action: "delete" });
    for (const sql of allSql()) {
      expect(sql).not.toContain("decrypted");
    }
  });
});

describe("table-editor conventions", () => {
  test("vault relations are SENSITIVE and READ-ONLY in the console", () => {
    expect(SENSITIVE_TABLES.has("vault.secrets")).toBe(true);
    expect(SENSITIVE_TABLES.has("vault.decrypted_secrets")).toBe(true);
    expect(READ_ONLY_TABLES.has("vault.secrets")).toBe(true);
    expect(READ_ONLY_TABLES.has("vault.decrypted_secrets")).toBe(true);
    expect(isReadOnlyTable("vault", "secrets")).toBe(true);
    expect(isReadOnlyTable("vault", "decrypted_secrets")).toBe(true);
  });
});
