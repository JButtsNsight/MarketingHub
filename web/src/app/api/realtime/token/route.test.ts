// @vitest-environment node
// The route mints/verifies jose HS256 JWTs and drives the verified (ES256)
// auth path; node env avoids the jsdom cross-realm Uint8Array mismatch that
// breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";
import { subForEmail, verifyUserJwt } from "@/lib/userJwt";

import { GET } from "./route";

const SECRET = "test-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const ANON_KEY = "test-anon-key-value";

let amyToken: string; // platform section
let bobToken: string; // platform section (second user — cross-user checks)
let viewerToken: string; // NO section
let marketingToken: string; // base group only — no section
let adminToken: string; // god-mode — implies every section

beforeAll(async () => {
  await initAlbKeys();
  amyToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["mh-section-platform"],
  });
  bobToken = await signAlbToken({
    email: "bob@nsight.example",
    name: "Bob",
    "cognito:groups": ["mh-section-platform"],
  });
  viewerToken = await signAlbToken({
    email: "carl@nsight.example",
    "cognito:groups": ["viewers"],
  });
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
    "cognito:groups": ["marketing"],
  });
  adminToken = await signAlbToken({
    email: "ada@nsight.example",
    "cognito:groups": ["marketinghub-admins"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  delete process.env.PREVIEW_AUTH; // exercise the REAL verification path
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
});

afterEach(() => {
  clearAlbEnv();
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_ANON_KEY;
});

function getReq(headers: HeadersInit = {}): Request {
  return new Request("http://x/api/realtime/token", { method: "GET", headers });
}

function asUser(token: string): HeadersInit {
  return { "x-amzn-oidc-data": token };
}

describe("GET /api/realtime/token", () => {
  test("401 when unauthenticated (no session header)", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.token).toBeUndefined();
  });

  test("403 when the session lacks the platform section", async () => {
    const res = await GET(getReq(asUser(viewerToken)));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.token).toBeUndefined();
  });

  test("403 for base marketing without the section; 200 for god-mode admins", async () => {
    expect((await GET(getReq(asUser(marketingToken)))).status).toBe(403);
    expect((await GET(getReq(asUser(adminToken)))).status).toBe(200);
  });

  test("503 {reason} when SUPABASE_JWT_SECRET is unset (flag off) — no token", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const res = await GET(getReq(asUser(amyToken)));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toMatch(/SUPABASE_JWT_SECRET/);
    expect(body.token).toBeUndefined();
    expect(body.anonKey).toBeUndefined();
  });

  test("503 {reason} when SUPABASE_ANON_KEY is unset — no token", async () => {
    delete process.env.SUPABASE_ANON_KEY;
    const res = await GET(getReq(asUser(amyToken)));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toMatch(/SUPABASE_ANON_KEY/);
    expect(body.token).toBeUndefined();
  });

  test("200 shape: {token, expiresAtMs, anonKey}; token is the caller's SELF identity", async () => {
    const before = Date.now();
    const res = await GET(getReq(asUser(amyToken)));
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "anonKey",
      "expiresAtMs",
      "token",
    ]);
    expect(body.anonKey).toBe(ANON_KEY);

    // TTL bound: expiresAtMs is in the future but NEVER beyond now + 300s.
    expect(body.expiresAtMs).toBeGreaterThan(before);
    expect(body.expiresAtMs).toBeLessThanOrEqual(after + 300_000);

    // The minted JWT verifies against the stack secret and is self-identity.
    const claims = await verifyUserJwt(body.token);
    expect(claims.role).toBe("authenticated");
    expect(claims.email).toBe("amy@nsight.example");
    expect(claims.sub).toBe(subForEmail("amy@nsight.example"));
    expect(claims.groups).toEqual(["mh-section-platform"]);

    // Token exp itself is bounded by the 300s default TTL.
    expect((claims.exp! - claims.iat!)).toBeLessThanOrEqual(300);
    // expiresAtMs never overstates the real exp (clients refresh 60s early).
    expect(body.expiresAtMs).toBeLessThanOrEqual(claims.exp! * 1000);
  });

  test("responses are never cacheable (no cross-user reuse via caches)", async () => {
    const ok = await GET(getReq(asUser(amyToken)));
    expect(ok.headers.get("cache-control")).toMatch(/no-store/);
    delete process.env.SUPABASE_JWT_SECRET;
    const unflagged = await GET(getReq(asUser(amyToken)));
    expect(unflagged.headers.get("cache-control")).toMatch(/no-store/);
  });

  test("no cross-user leak: back-to-back sessions each get their OWN token", async () => {
    const amyRes = await GET(getReq(asUser(amyToken)));
    const bobRes = await GET(getReq(asUser(bobToken)));
    expect(amyRes.status).toBe(200);
    expect(bobRes.status).toBe(200);

    const amyBody = await amyRes.json();
    const bobBody = await bobRes.json();
    expect(amyBody.token).not.toBe(bobBody.token);

    const amyClaims = await verifyUserJwt(amyBody.token);
    const bobClaims = await verifyUserJwt(bobBody.token);
    expect(amyClaims.email).toBe("amy@nsight.example");
    expect(bobClaims.email).toBe("bob@nsight.example");
    expect(amyClaims.sub).not.toBe(bobClaims.sub);
    expect(bobClaims.sub).toBe(subForEmail("bob@nsight.example"));
  });
});
