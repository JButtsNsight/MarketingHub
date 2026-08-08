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

// Mock ONLY listUsers; the real GoTrueUnavailableError class stays live so the
// route instanceof-checks against the same object production does.
const h = vi.hoisted(() => ({ listUsers: vi.fn() }));

vi.mock("@/lib/console/gotrue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/gotrue")>();
  return { ...actual, listUsers: h.listUsers };
});

import { GoTrueUnavailableError } from "@/lib/console/gotrue";
import * as routeModule from "./route";
import { GET } from "./route";

let marketingToken: string;
let viewersToken: string;

const USERS = [
  {
    id: "5f5e1f9d-6a3a-4d3e-9a51-1c2f3a4b5c6d",
    aud: "authenticated",
    role: "authenticated",
    email: "ada@nsight.example",
    app_metadata: { provider: "email" },
    user_metadata: {},
    identities: null,
    created_at: "2026-08-01T00:00:00Z",
    is_anonymous: false,
  },
];

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
  h.listUsers.mockReset().mockResolvedValue({ users: USERS, total: 1 });
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function get(qs: string, headers: HeadersInit = marketingHeaders()) {
  return GET(new Request(`http://x/api/console/gotrue/users${qs}`, { headers }));
}

describe("GET /api/console/gotrue/users — export surface (read-only wave)", () => {
  test("GET is the only verb — Next auto-405s everything else", () => {
    // The hard Wave 3-partial constraint: zero mutation exports means Next
    // answers 405 for POST/PUT/PATCH/DELETE without any handler existing.
    const exported = Object.keys(routeModule).sort();
    expect(exported).toEqual(["GET", "dynamic"]);
  });
});

describe("GET /api/console/gotrue/users — auth gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request("http://x/api/console/gotrue/users"));
    expect(res.status).toBe(401);
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const res = await get("", { "x-amzn-oidc-data": viewersToken });
    expect(res.status).toBe(403);
    expect(h.listUsers).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/gotrue/users — param validation", () => {
  test("200 with defaults when no params are sent", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: USERS, total: 1 });
    expect(h.listUsers).toHaveBeenCalledTimes(1);
    expect(h.listUsers).toHaveBeenCalledWith({
      page: undefined,
      perPage: undefined,
      filter: undefined,
      sort: undefined,
    });
  });

  test("forwards page, per_page, filter, and sort", async () => {
    const res = await get("?page=3&per_page=25&filter=ada&sort=asc");
    expect(res.status).toBe(200);
    expect(h.listUsers).toHaveBeenCalledWith({
      page: 3,
      perPage: 25,
      filter: "ada",
      sort: "asc",
    });
  });

  test("400 on a non-positive or non-integer page", async () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      const res = await get(`?page=${bad}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/page must be a positive integer/);
    }
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  test("400 when per_page is outside [1, 100] or not an integer", async () => {
    for (const bad of ["0", "101", "12.5", "abc"]) {
      const res = await get(`?per_page=${bad}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/per_page must be an integer/);
    }
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  test("400 when filter exceeds 200 characters", async () => {
    const res = await get(`?filter=${"a".repeat(201)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at most 200 characters/);
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  test("whitespace-only filter is treated as absent", async () => {
    const res = await get("?filter=%20%20%20");
    expect(res.status).toBe(200);
    expect(h.listUsers.mock.calls[0][0].filter).toBeUndefined();
  });

  test("400 on a sort direction outside asc|desc", async () => {
    const res = await get("?sort=up");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/sort must be one of asc, desc/);
    expect(h.listUsers).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/gotrue/users — failure mapping", () => {
  test("GoTrueUnavailableError maps to 503 + unavailable flag", async () => {
    h.listUsers.mockRejectedValueOnce(
      new GoTrueUnavailableError("timed out after 30000 ms"),
    );
    const res = await get("");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unavailable).toBe(true);
    expect(body.error).toBe("gotrue unreachable: timed out after 30000 ms");
  });

  test("[console:gotrue] failures map to 400 with the stripped message", async () => {
    h.listUsers.mockRejectedValueOnce(
      new Error("[console:gotrue] list-users failed: 403 not_admin: nope"),
    );
    const res = await get("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("403 not_admin: nope");
    expect(body.unavailable).toBeUndefined();
  });
});
