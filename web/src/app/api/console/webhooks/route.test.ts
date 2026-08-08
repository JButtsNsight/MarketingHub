// @vitest-environment node
// The route runs the real (jose ES256) auth path; node env avoids the jsdom
// cross-realm Uint8Array mismatch that breaks WebCrypto verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

// The foundation data layer is mocked; the auth gate + validation + error
// mapping under test live in the route itself. dbobjects.OBJECT_SCHEMAS and
// webhooks.WEBHOOKS_ADMIN_ROLE must be provided because the route imports them.
const h = vi.hoisted(() => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  dropWebhook: vi.fn(),
  runQuery: vi.fn(),
  listTables: vi.fn(),
}));

vi.mock("@/lib/console/webhooks", () => ({
  listWebhooks: h.listWebhooks,
  createWebhook: h.createWebhook,
  dropWebhook: h.dropWebhook,
  WEBHOOKS_ADMIN_ROLE: "webhooks_admin",
}));

vi.mock("@/lib/console/dbobjects", () => ({
  OBJECT_SCHEMAS: ["public", "marketinghub", "storage"],
}));

vi.mock("@/lib/console/pgmeta", () => ({
  runQuery: h.runQuery,
  listTables: h.listTables,
}));

import { DELETE, GET, POST } from "./route";

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.listWebhooks.mockReset();
  h.createWebhook.mockReset();
  h.dropWebhook.mockReset();
  h.runQuery.mockReset();
  h.listTables.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function headers(token = marketingToken): HeadersInit {
  return { "x-amzn-oidc-data": token, "content-type": "application/json" };
}

function req(method: string, body?: unknown, token = marketingToken): Request {
  return new Request("http://x/api/console/webhooks", {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const HOOKS = [
  {
    schema: "public",
    table: "notes",
    name: "notes_webhook",
    events: ["insert", "delete"],
    enabled: true,
    url: "https://example.com/hook",
    method: "POST",
    definition: "CREATE TRIGGER notes_webhook ...",
  },
];

const LIVE_TABLES = [
  { schema: "marketinghub", name: "templates" },
  { schema: "public", name: "notes" },
];

describe("GET /api/console/webhooks", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req("GET", undefined, ""));
    expect(res.status).toBe(401);
    expect(h.listWebhooks).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await GET(req("GET", undefined, viewersToken));
    expect(res.status).toBe(403);
  });

  test("200: returns webhooks, sorted tables, and a ready flag from the role probe", async () => {
    h.listWebhooks.mockResolvedValue(HOOKS);
    h.listTables.mockResolvedValue(LIVE_TABLES);
    h.runQuery.mockResolvedValue([{ ready: true }]);

    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.webhooks).toEqual(HOOKS);
    expect(json.ready).toBe(true);
    // Sorted "schema.name": marketinghub.templates < public.notes.
    expect(json.availableTables).toEqual([
      { schema: "marketinghub", name: "templates" },
      { schema: "public", name: "notes" },
    ]);
    // The readiness probe passes the role through quote_literal — never raw.
    expect(String(h.runQuery.mock.calls[0][0])).toContain("rolname = 'webhooks_admin'");
  });

  test("ready is false when the role probe returns false", async () => {
    h.listWebhooks.mockResolvedValue([]);
    h.listTables.mockResolvedValue([]);
    h.runQuery.mockResolvedValue([{ ready: false }]);
    const res = await GET(req("GET"));
    const json = await res.json();
    expect(json.ready).toBe(false);
  });
});

describe("POST /api/console/webhooks (create)", () => {
  test("400 on an invalid webhook name (never reaches the lib)", async () => {
    const res = await POST(
      req("POST", {
        schema: "public",
        table: "notes",
        name: "bad; drop table x",
        events: ["insert"],
        url: "https://example.com/x",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.createWebhook).not.toHaveBeenCalled();
  });

  test("400 when no event is selected (never reaches the lib)", async () => {
    const res = await POST(
      req("POST", {
        schema: "public",
        table: "notes",
        name: "hook",
        events: [],
        url: "https://example.com/x",
      }),
    );
    expect(res.status).toBe(400);
    expect(h.createWebhook).not.toHaveBeenCalled();
  });

  test("201: delegates to createWebhook with the validated input", async () => {
    h.createWebhook.mockResolvedValue(undefined);
    const res = await POST(
      req("POST", {
        schema: "public",
        table: "notes",
        name: "hook",
        events: ["insert", "update"],
        url: "https://example.com/x",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(201);
    expect(h.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "public",
        table: "notes",
        name: "hook",
        events: ["insert", "update"],
        url: "https://example.com/x",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  test("maps a [console:webhooks] failure (role missing) to a 400 with the stripped message", async () => {
    h.createWebhook.mockRejectedValue(
      new Error(
        "[console:webhooks] create failed: the webhooks_admin role does not exist — apply cdk/sql/2026-08-07-scope-pg-net.sql before creating webhooks",
      ),
    );
    const res = await POST(
      req("POST", {
        schema: "public",
        table: "notes",
        name: "hook",
        events: ["insert"],
        url: "https://example.com/x",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("the webhooks_admin role does not exist");
    expect(json.error).not.toContain("[console:");
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      req(
        "POST",
        {
          schema: "public",
          table: "notes",
          name: "hook",
          events: ["insert"],
          url: "https://example.com/x",
        },
        viewersToken,
      ),
    );
    expect(res.status).toBe(403);
    expect(h.createWebhook).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/console/webhooks (drop)", () => {
  test("200: delegates to dropWebhook", async () => {
    h.dropWebhook.mockResolvedValue(undefined);
    const res = await DELETE(
      req("DELETE", { schema: "public", table: "notes", name: "notes_webhook" }),
    );
    expect(res.status).toBe(200);
    expect(h.dropWebhook).toHaveBeenCalledWith("public", "notes", "notes_webhook");
  });

  test("400 on an invalid identifier (never reaches the lib)", async () => {
    const res = await DELETE(
      req("DELETE", { schema: "public", table: "notes", name: "1bad" }),
    );
    expect(res.status).toBe(400);
    expect(h.dropWebhook).not.toHaveBeenCalled();
  });

  test("maps a [console:webhooks] failure to a 400 with the stripped message", async () => {
    h.dropWebhook.mockRejectedValue(
      new Error(
        "[console:webhooks] drop failed: webhook nope on public.notes does not exist",
      ),
    );
    const res = await DELETE(
      req("DELETE", { schema: "public", table: "notes", name: "nope" }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("webhook nope on public.notes does not exist");
  });
});
