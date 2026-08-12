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

// Mock ONLY the five metric functions; the real AnalyticsUnavailableError
// class stays live so the route instanceof-checks against the same object
// production does (mirrors the /api/console/logs test).
const h = vi.hoisted(() => ({
  apiRequestVolume: vi.fn(),
  apiErrorRates: vi.fn(),
  topRoutes: vi.fn(),
  authEvents: vi.fn(),
  serviceLogVolume: vi.fn(),
}));

vi.mock("@/lib/console/logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/logs")>();
  return { ...actual, ...h };
});

import { AnalyticsUnavailableError } from "@/lib/console/logs";
import { GET } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

const VOLUME_ROWS = [
  {
    bucket: "2026-08-08T10:00:00.000Z",
    total: 12,
    rest: 8,
    auth: 2,
    storage: 1,
    realtime: 1,
    functions: 0,
  },
];

const allMocks = Object.values(h);

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
  platformToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["mh-section-platform"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of allMocks) fn.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  clearAlbEnv();
});

// Reports sits in the base marketing tier (Wave D role model), NOT platform.
function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function url(qs: string): string {
  return `http://x/api/console/reports${qs}`;
}

describe("GET /api/console/reports", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request(url("?metric=apiRequestVolume")));
    expect(res.status).toBe(401);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("403 when authenticated without the marketing group", async () => {
    const res = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: { "x-amzn-oidc-data": viewersToken },
      }),
    );
    expect(res.status).toBe(403);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("base marketing passes; a platform-only section does NOT (marketing tier, not platform)", async () => {
    const ok = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: marketingHeaders(),
      }),
    );
    expect(ok.status).toBe(200);

    const forbidden = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: { "x-amzn-oidc-data": platformToken },
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  test("the marketing gate keeps its historical meaning — even god-mode needs the group", async () => {
    // Per the Wave D role model, admins imply every SECTION, but `marketing`
    // is the base tier every user holds; an admin token without it 403s here
    // exactly as it did before the wave.
    const res = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: { "x-amzn-oidc-data": adminToken },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("400 when metric is missing — nothing runs", async () => {
    const res = await GET(new Request(url(""), { headers: marketingHeaders() }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/metric must be one of/);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("400 on an unknown metric name — nothing runs", async () => {
    const res = await GET(
      new Request(url("?metric=pg_sleep"), { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/metric must be one of/);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("400 on prototype-chain names (constructor) — record lookup is own-key only", async () => {
    const res = await GET(
      new Request(url("?metric=constructor"), { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(400);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("200 runs the metric over the default 24h/hour window and echoes rows", async () => {
    h.apiRequestVolume.mockResolvedValue(VOLUME_ROWS);
    const res = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metric).toBe("apiRequestVolume");
    expect(body.preset).toBe("24h");
    expect(body.interval).toBe("hour");
    expect(body.rows).toEqual(VOLUME_ROWS);

    const call = h.apiRequestVolume.mock.calls[0][0];
    expect(call.interval).toBe("hour");
    expect(call.to.getTime() - call.from.getTime()).toBe(86_400_000);
    expect(body.from).toBe(call.from.toISOString());
    expect(body.to).toBe(call.to.toISOString());
  });

  test("preset=1h maps to a minute-bucketed one-hour window", async () => {
    await GET(
      new Request(url("?metric=apiErrorRates&preset=1h"), {
        headers: marketingHeaders(),
      }),
    );
    const call = h.apiErrorRates.mock.calls[0][0];
    expect(call.interval).toBe("minute");
    expect(call.to.getTime() - call.from.getTime()).toBe(3_600_000);
  });

  test("preset=7d maps to a day-bucketed seven-day window", async () => {
    await GET(
      new Request(url("?metric=serviceLogVolume&preset=7d"), {
        headers: marketingHeaders(),
      }),
    );
    const call = h.serviceLogVolume.mock.calls[0][0];
    expect(call.interval).toBe("day");
    expect(call.to.getTime() - call.from.getTime()).toBe(604_800_000);
  });

  test("400 on an unknown preset — nothing runs", async () => {
    const res = await GET(
      new Request(url("?metric=authEvents&preset=90d"), {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/preset must be one of/);
    for (const fn of allMocks) expect(fn).not.toHaveBeenCalled();
  });

  test("topRoutes runs with the fixed server-side limit", async () => {
    await GET(
      new Request(url("?metric=topRoutes&preset=1h"), {
        headers: marketingHeaders(),
      }),
    );
    const call = h.topRoutes.mock.calls[0][0];
    expect(call.limit).toBe(20);
    expect(call.to.getTime() - call.from.getTime()).toBe(3_600_000);
  });

  test("maps a [console:logs] failure to 400 with the stripped message", async () => {
    h.authEvents.mockRejectedValueOnce(
      new Error("[console:logs] auth-events failed: translator exploded"),
    );
    const res = await GET(
      new Request(url("?metric=authEvents"), { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("translator exploded");
  });

  test("maps the unreachable state to 503 + unavailable flag (same contract as /api/console/logs)", async () => {
    h.apiRequestVolume.mockRejectedValueOnce(
      new AnalyticsUnavailableError(
        "Kong returned 404 — the analytics-v1-api route is not enabled",
      ),
    );
    const res = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unavailable).toBe(true);
    expect(body.error).toMatch(/^analytics unreachable: /);
  });

  test("plain [console:logs] failures keep the 400 mapping (no unavailable flag)", async () => {
    h.apiRequestVolume.mockRejectedValueOnce(
      new Error("[console:logs] api-request-volume failed: logflare said no"),
    );
    const res = await GET(
      new Request(url("?metric=apiRequestVolume"), {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("logflare said no");
    expect(body.unavailable).toBeUndefined();
  });
});
