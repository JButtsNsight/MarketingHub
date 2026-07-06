import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/supabase.ts");

describe("lib/supabase server client", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    process.env = { ...OLD };
  });

  test("module is marked server-only", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  test("throws (fail-loud) when SUPABASE_URL is missing", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    const { getServiceClient } = await import("./supabase.ts");
    expect(() => getServiceClient()).toThrow(/SUPABASE_URL/);
  });

  test("throws (fail-loud) when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    process.env.SUPABASE_URL = "https://mh.supabase.example.com";
    const { getServiceClient } = await import("./supabase.ts");
    expect(() => getServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  test("returns a Supabase client when both env vars are set", async () => {
    process.env.SUPABASE_URL = "https://mh.supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    const { getServiceClient } = await import("./supabase.ts");
    const client = getServiceClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
    expect(client.storage).toBeDefined();
  });
});
