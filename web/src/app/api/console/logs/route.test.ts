// @vitest-environment node
// The route runs the verified (jose ES256) ALB auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
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

// Mock ONLY queryLogs; the real allowlists (LOG_SOURCES) and the real
// AnalyticsUnavailableError class stay live so the route validates against —
// and instanceof-checks against — the same objects production does.
const h = vi.hoisted(() => ({ queryLogs: vi.fn(), liveGroupsFor: vi.fn() }));

vi.mock("@/lib/console/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/logs")>();
  return { ...actual, queryLogs: h.queryLogs };
});

// The admin gate consults the live pool through requireAdminApi; mock ONLY
// liveGroupsFor (null = fail-open, token verdict stands — the default).
vi.mock("@/lib/cognitoAdmin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cognitoAdmin")>();
  return { ...actual, liveGroupsFor: h.liveGroupsFor };
});

import { AnalyticsUnavailableError } from "@/lib/console/logs";
import { GET } from "./route";

let adminToken: string;
let marketingToken: string;

const ENTRIES = [
  {
    ts: "2026-08-08T12:00:00.000Z",
    level: "info",
    service: "api",
    event: "GET /rest/v1/templates 200",
    metadata: { response: [{ status_code: 200 }] },
  },
];

beforeAll(async () => {
  await initAlbKeys();
  adminToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing", "marketinghub-admins"],
  });
  marketingToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["marketing"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.queryLogs.mockReset().mockResolvedValue(ENTRIES);
  h.liveGroupsFor.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  clearAlbEnv();
});

function adminHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": adminToken };
}

function get(qs: string, headers: HeadersInit = adminHeaders()) {
  return GET(new Request(`http://x/api/console/logs${qs}`, { headers }));
}

describe("GET /api/console/logs — auth gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request("http://x/api/console/logs?source=edge_logs"));
    expect(res.status).toBe(401);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("403 admin-only when authenticated without the admin group", async () => {
    const res = await get("?source=edge_logs", {
      "x-amzn-oidc-data": marketingToken,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin-only" });
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("403 admin-only when the LIVE pool no longer grants admin (revoked since sign-in)", async () => {
    h.liveGroupsFor.mockResolvedValue(["marketing"]);
    const res = await get("?source=edge_logs");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin-only" });
    expect(h.queryLogs).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/logs — param validation", () => {
  test("200 queries the source with the default 1h preset", async () => {
    const res = await get("?source=edge_logs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: ENTRIES });
    expect(h.queryLogs).toHaveBeenCalledTimes(1);
    const params = h.queryLogs.mock.calls[0][0];
    expect(params.source).toBe("edge_logs");
    expect(params.severities).toBeUndefined();
    expect(params.search).toBeUndefined();
    expect(params.limit).toBeUndefined();
    expect(params.to).toBeInstanceOf(Date);
    expect(params.from).toBeInstanceOf(Date);
    expect(params.to.getTime() - params.from.getTime()).toBe(3_600_000);
  });

  test("presets resolve to from/to server-side (7d)", async () => {
    const res = await get("?source=postgres_logs&preset=7d");
    expect(res.status).toBe(200);
    const params = h.queryLogs.mock.calls[0][0];
    expect(params.to.getTime() - params.from.getTime()).toBe(
      7 * 24 * 3_600_000,
    );
    // The preset never reaches the lib — only the resolved Dates do.
    expect(params.preset).toBeUndefined();
  });

  test("400 when source is missing", async () => {
    const res = await get("");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source must be one of/);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("400 on a source outside the allowlist", async () => {
    const res = await get("?source=function_logs");
    expect(res.status).toBe(400);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("400 on an unknown preset", async () => {
    const res = await get("?source=edge_logs&preset=90d");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/preset must be one of/);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("passes allowlisted severities through as an array", async () => {
    const res = await get("?source=edge_logs&severities=info,warn");
    expect(res.status).toBe(200);
    expect(h.queryLogs.mock.calls[0][0].severities).toEqual(["info", "warn"]);
  });

  test("400 when a severity is outside the source's allowlist", async () => {
    // FATAL is a postgres_logs severity — not an edge_logs one.
    const res = await get("?source=edge_logs&severities=info,FATAL");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not allowed for edge_logs/);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("400 when the source has no severity filter at all", async () => {
    const res = await get("?source=postgrest_logs&severities=info");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /does not support severity filtering/,
    );
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("forwards search and limit", async () => {
    const res = await get(
      `?source=auth_logs&search=${encodeURIComponent("token 50%")}&limit=250`,
    );
    expect(res.status).toBe(200);
    const params = h.queryLogs.mock.calls[0][0];
    expect(params.search).toBe("token 50%");
    expect(params.limit).toBe(250);
  });

  test("400 when search exceeds 200 characters", async () => {
    const res = await get(`?source=edge_logs&search=${"a".repeat(201)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 200 characters/);
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("400 when search carries a backslash or control character", async () => {
    for (const bad of ["a\\b", "a\u0000b", "a\nb"]) {
      const res = await get(
        `?source=edge_logs&search=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
    }
    expect(h.queryLogs).not.toHaveBeenCalled();
  });

  test("400 on a non-integer limit", async () => {
    for (const bad of ["abc", "12.5"]) {
      const res = await get(`?source=edge_logs&limit=${bad}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/limit must be an integer/);
    }
    expect(h.queryLogs).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/logs — failure mapping", () => {
  test("AnalyticsUnavailableError maps to 503 + unavailable flag", async () => {
    h.queryLogs.mockRejectedValueOnce(
      new AnalyticsUnavailableError("token missing"),
    );
    const res = await get("?source=edge_logs");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unavailable).toBe(true);
    expect(body.error).toBe("analytics unreachable: token missing");
  });

  test("[console:logs] failures map to 400 with the stripped message", async () => {
    h.queryLogs.mockRejectedValueOnce(
      new Error("[console:logs] query-logs failed: logflare said no"),
    );
    const res = await get("?source=edge_logs");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("logflare said no");
    expect(body.unavailable).toBeUndefined();
  });
});
