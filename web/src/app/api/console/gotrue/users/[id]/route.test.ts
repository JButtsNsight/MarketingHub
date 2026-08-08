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

// Mock ONLY getUser; the real GoTrueUnavailableError class stays live so the
// route instanceof-checks against the same object production does.
const h = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@/lib/console/gotrue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/gotrue")>();
  return { ...actual, getUser: h.getUser };
});

import { GoTrueUnavailableError } from "@/lib/console/gotrue";
import * as routeModule from "./route";
import { GET } from "./route";

let marketingToken: string;
let viewersToken: string;

const USER_ID = "5f5e1f9d-6a3a-4d3e-9a51-1c2f3a4b5c6d";

const DETAIL_USER = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "ada@nsight.example",
  app_metadata: { provider: "email" },
  user_metadata: { full_name: "Ada" },
  identities: [
    {
      identity_id: "11111111-2222-3333-4444-555555555555",
      id: "ada@nsight.example",
      provider: "email",
      created_at: "2026-08-01T00:00:00Z",
      last_sign_in_at: "2026-08-05T00:00:00Z",
    },
  ],
  factors: [],
  created_at: "2026-08-01T00:00:00Z",
  is_anonymous: false,
};

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
  h.getUser.mockReset().mockResolvedValue(DETAIL_USER);
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function get(id: string, headers: HeadersInit = marketingHeaders()) {
  return GET(
    new Request(
      `http://x/api/console/gotrue/users/${encodeURIComponent(id)}`,
      { headers },
    ),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/console/gotrue/users/[id] — export surface (read-only wave)", () => {
  test("GET is the only verb — Next auto-405s everything else", () => {
    // GoTrue exposes PUT/DELETE on this path upstream; this route must never
    // grow them (hard Wave 3-partial constraint). Zero mutation exports
    // means Next answers 405 for POST/PUT/PATCH/DELETE by itself.
    const exported = Object.keys(routeModule).sort();
    expect(exported).toEqual(["GET", "dynamic"]);
  });
});

describe("GET /api/console/gotrue/users/[id] — auth gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(
      new Request(`http://x/api/console/gotrue/users/${USER_ID}`),
      { params: Promise.resolve({ id: USER_ID }) },
    );
    expect(res.status).toBe(401);
    expect(h.getUser).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const res = await get(USER_ID, { "x-amzn-oidc-data": viewersToken });
    expect(res.status).toBe(403);
    expect(h.getUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/gotrue/users/[id] — param validation", () => {
  test("200 returns the eager-loaded user", async () => {
    const res = await get(USER_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: DETAIL_USER });
    expect(h.getUser).toHaveBeenCalledTimes(1);
    expect(h.getUser).toHaveBeenCalledWith(USER_ID);
  });

  test("400 on a blank id, before any lib call", async () => {
    for (const bad of ["", "   "]) {
      const res = await get(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/non-empty user id/);
    }
    expect(h.getUser).not.toHaveBeenCalled();
  });

  test("400 on an id longer than 100 characters, before any lib call", async () => {
    const res = await get("a".repeat(101));
    expect(res.status).toBe(400);
    expect(h.getUser).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/gotrue/users/[id] — failure mapping", () => {
  test("GoTrueUnavailableError maps to 503 + unavailable flag", async () => {
    h.getUser.mockRejectedValueOnce(
      new GoTrueUnavailableError("Kong returned 503 — GoTrue is unavailable behind Kong"),
    );
    const res = await get(USER_ID);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.unavailable).toBe(true);
    expect(body.error).toMatch(/^gotrue unreachable: /);
  });

  test("a GoTrue 404 (real answer) maps to 400, never unavailable", async () => {
    h.getUser.mockRejectedValueOnce(
      new Error(
        "[console:gotrue] get-user failed: 404 user_not_found: User not found",
      ),
    );
    const res = await get(USER_ID);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("404 user_not_found: User not found");
    expect(body.unavailable).toBeUndefined();
  });
});
