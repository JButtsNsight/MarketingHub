// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ runQuery: vi.fn() }));

vi.mock("./pgmeta", () => ({ runQuery: h.runQuery }));

import {
  ADVISOR_CHECKS,
  runAdvisorCheck,
  runAdvisors,
  type AdvisorLevel,
} from "./advisors";

beforeEach(() => {
  h.runQuery.mockReset();
});

describe("ADVISOR_CHECKS", () => {
  test("covers both levels with unique ids", () => {
    const ids = ADVISOR_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ADVISOR_CHECKS.some((c) => c.level === "security")).toBe(true);
    expect(ADVISOR_CHECKS.some((c) => c.level === "performance")).toBe(true);
  });

  test("only reference the exposed schemas, never user input", () => {
    for (const c of ADVISOR_CHECKS) {
      expect(c.sql).not.toMatch(/\$\{/); // no template interpolation survived
    }
  });
});

describe("runAdvisorCheck", () => {
  test("maps rows into lints and falls back to the title when detail is empty", async () => {
    const check = ADVISOR_CHECKS.find((c) => c.id === "rls_disabled_in_exposed_schema")!;
    h.runQuery.mockResolvedValue([
      { schema: "public", object: "leaky", detail: "" },
    ]);
    const lints = await runAdvisorCheck(check);
    expect(lints).toEqual([
      {
        id: "rls_disabled_in_exposed_schema",
        level: "security",
        severity: "error",
        title: check.title,
        detail: check.title,
        schema: "public",
        object: "leaky",
        remediation: check.remediation,
      },
    ]);
  });
});

/** Route runQuery to a fixed result per check by a distinctive SQL fragment. */
function routeChecks() {
  h.runQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("and not c.relrowsecurity")) {
      return [{ schema: "public", object: "leaky", detail: "no rls" }];
    }
    if (sql.includes("proconfig")) {
      return [{ schema: "public", object: "fn", detail: "mutable path" }];
    }
    if (sql.includes("pg_stat_user_indexes")) {
      return [{ schema: "public", object: "idx_dead", detail: "unused" }];
    }
    if (sql.includes("string_agg(ic.relname")) {
      throw new Error("[console:pgmeta] query failed: 42883 dup check exploded");
    }
    return [];
  });
}

describe("runAdvisors", () => {
  test("orders findings error→warn→info and records failed checks", async () => {
    routeChecks();
    const report = await runAdvisors();

    expect(report.lints.map((l) => l.severity)).toEqual(["error", "warn", "info"]);
    expect(report.lints.map((l) => l.id)).toEqual([
      "rls_disabled_in_exposed_schema",
      "function_search_path_mutable",
      "unused_index",
    ]);
    expect(report.failed).toEqual([
      { id: "duplicate_index", error: expect.stringContaining("dup check exploded") },
    ]);
  });

  test("a level filter only runs that level's checks", async () => {
    routeChecks();
    const report = await runAdvisors("performance" as AdvisorLevel);
    expect(report.lints.map((l) => l.id)).toEqual(["unused_index"]);
    expect(report.failed.map((f) => f.id)).toEqual(["duplicate_index"]);
    // No security-only SQL should have been executed.
    const executed = h.runQuery.mock.calls.map((c) => String(c[0]));
    expect(executed.some((s) => s.includes("proconfig"))).toBe(false);
  });
});
