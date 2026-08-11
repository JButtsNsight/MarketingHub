import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// next/headers exists only inside a Next request scope; mock it (auth.test.ts
// pattern) so getPreviewPersona can read the persona cookie under test.
const nextMocks = vi.hoisted(() => ({ cookie: null as string | null }));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name.toLowerCase() === "cookie" ? nextMocks.cookie : null,
    }),
}));

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/console/settings.ts");

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALB_ARN",
  "ALB_REGION",
  "AWS_REGION",
  "COGNITO_LOGOUT_URL",
  "PREVIEW_AUTH",
  "MONDAY_API_TOKEN",
  "SIMPLETEXTING_WEBHOOK_TOKEN",
  "SIMPLETEXTING_API_TOKEN",
] as const;

describe("lib/console/settings", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    nextMocks.cookie = null;
  });

  afterEach(() => {
    process.env = { ...OLD };
  });

  test("module is marked server-only", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  describe("getConnectionInfo", () => {
    test("reports only presence booleans plus the (non-secret) host", async () => {
      process.env.SUPABASE_URL = "https://data.mh.internal.example.com";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key-value";
      const { getConnectionInfo } = await import("./settings");
      const info = getConnectionInfo();
      expect(info.supabaseUrlHost).toBe("data.mh.internal.example.com");
      expect(info.serviceRoleKeySet).toBe(true);
      expect(info.albArnSet).toBe(false);
      expect(JSON.stringify(info)).not.toContain("svc-key-value");
    });
  });

  describe("getPreviewPersona", () => {
    test("null when the shim is off — cookie never consulted", async () => {
      nextMocks.cookie = "mh-preview-persona=member";
      const { getPreviewPersona } = await import("./settings");
      expect(await getPreviewPersona()).toBeNull();
    });

    test("admin when the shim grants the admin group and no cookie demotes", async () => {
      process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
      const { getPreviewPersona } = await import("./settings");
      expect(await getPreviewPersona()).toBe("admin");
    });

    test("member when the mh-preview-persona=member cookie demotes", async () => {
      process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
      nextMocks.cookie = "mh-preview-persona=member";
      const { getPreviewPersona } = await import("./settings");
      expect(await getPreviewPersona()).toBe("member");
    });

    test("only the literal value 'member' demotes", async () => {
      process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
      nextMocks.cookie = "mh-preview-persona=Member";
      const { getPreviewPersona } = await import("./settings");
      expect(await getPreviewPersona()).toBe("admin");
    });

    test("member when the shim never granted the admin group (honest chip)", async () => {
      process.env.PREVIEW_AUTH = "marketing";
      const { getPreviewPersona } = await import("./settings");
      expect(await getPreviewPersona()).toBe("member");
    });
  });

  describe("getSmsCampaignsInfo", () => {
    test("all unconfigured when no SMS env is set", async () => {
      const { getSmsCampaignsInfo } = await import("./settings");
      expect(getSmsCampaignsInfo()).toEqual({
        mondayTokenSet: false,
        simpletextingWebhookTokenSet: false,
        simpletextingSendTokenSet: false,
      });
    });

    test("MONDAY_API_TOKEN presence flips mondayTokenSet only", async () => {
      process.env.MONDAY_API_TOKEN = "monday-secret-token";
      const { getSmsCampaignsInfo } = await import("./settings");
      const info = getSmsCampaignsInfo();
      expect(info.mondayTokenSet).toBe(true);
      expect(info.simpletextingWebhookTokenSet).toBe(false);
      expect(info.simpletextingSendTokenSet).toBe(false);
    });

    test("SIMPLETEXTING_WEBHOOK_TOKEN presence flips simpletextingWebhookTokenSet", async () => {
      process.env.SIMPLETEXTING_WEBHOOK_TOKEN = "hook-secret-token";
      const { getSmsCampaignsInfo } = await import("./settings");
      expect(getSmsCampaignsInfo().simpletextingWebhookTokenSet).toBe(true);
    });

    test("SIMPLETEXTING_API_TOKEN presence flips simpletextingSendTokenSet (normally worker-only)", async () => {
      process.env.SIMPLETEXTING_API_TOKEN = "send-secret-token";
      const { getSmsCampaignsInfo } = await import("./settings");
      expect(getSmsCampaignsInfo().simpletextingSendTokenSet).toBe(true);
    });

    test("returns booleans only — never any secret value", async () => {
      process.env.MONDAY_API_TOKEN = "monday-secret-token";
      process.env.SIMPLETEXTING_WEBHOOK_TOKEN = "hook-secret-token";
      process.env.SIMPLETEXTING_API_TOKEN = "send-secret-token";
      const { getSmsCampaignsInfo } = await import("./settings");
      const info = getSmsCampaignsInfo();
      for (const value of Object.values(info)) {
        expect(typeof value).toBe("boolean");
      }
      const dumped = JSON.stringify(info);
      expect(dumped).not.toContain("secret-token");
    });
  });
});
