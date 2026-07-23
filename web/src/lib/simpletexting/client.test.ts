// @vitest-environment node
// The SimpleTexting client is server-only fetch code destined for the
// dispatcher worker; node env exercises the real undici Response/AbortSignal
// implementations the worker will see (no jsdom fetch shims).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isSimpleTextingConfigured } from "./client";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/simpletexting/client.ts");

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.SIMPLETEXTING_API_TOKEN = "st-test-token";
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
});

describe("module contract", () => {
  test("import \"server-only\" is the first line", () => {
    const firstLine = readFileSync(SRC, "utf8").split("\n")[0];
    expect(firstLine).toBe('import "server-only";');
  });
});

describe("isSimpleTextingConfigured", () => {
  test("false when SIMPLETEXTING_API_TOKEN is unset", () => {
    delete process.env.SIMPLETEXTING_API_TOKEN;
    expect(isSimpleTextingConfigured()).toBe(false);
  });

  test("false when SIMPLETEXTING_API_TOKEN is empty", () => {
    process.env.SIMPLETEXTING_API_TOKEN = "";
    expect(isSimpleTextingConfigured()).toBe(false);
  });

  test("true when SIMPLETEXTING_API_TOKEN is set", () => {
    expect(isSimpleTextingConfigured()).toBe(true);
  });
});
