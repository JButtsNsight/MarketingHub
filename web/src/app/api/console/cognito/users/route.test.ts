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

// The route talks to Cognito ONLY through the foundation lib; mock the module
// wholesale (its own suite covers the pool calls through the invoker seam).
const h = vi.hoisted(() => ({
  listPoolUsers: vi.fn(),
  groupsForUser: vi.fn(),
  liveGroupsFor: vi.fn(),
}));

vi.mock("@/lib/cognitoAdmin", () => ({
  listPoolUsers: h.listPoolUsers,
  groupsForUser: h.groupsForUser,
  liveGroupsFor: h.liveGroupsFor,
}));

import * as routeModule from "./route";
import { GET } from "./route";

let adminToken: string;
let marketingToken: string;

const AMY = {
  username: "u-amy",
  email: "amy@nsight.example",
  status: "CONFIRMED",
  created: "2026-08-01T00:00:00.000Z",
  enabled: true,
};

const BOB = {
  username: "u-bob",
  email: "bob@nsight.example",
  status: "CONFIRMED",
  created: "2026-08-02T00:00:00.000Z",
  enabled: true,
};

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
  h.listPoolUsers.mockReset().mockResolvedValue([AMY, BOB]);
  h.groupsForUser
    .mockReset()
    .mockImplementation(async (username: string) =>
      username === "u-amy" ? ["marketing", "marketinghub-admins"] : ["marketing"],
    );
  h.liveGroupsFor.mockReset().mockResolvedValue(null); // live check unavailable
});

afterEach(() => {
  clearAlbEnv();
  vi.restoreAllMocks();
});

function get(headers: HeadersInit = { "x-amzn-oidc-data": adminToken }) {
  return GET(new Request("http://x/api/console/cognito/users", { headers }));
}

describe("GET /api/console/cognito/users — export surface", () => {
  test("GET is the only verb — mutations live on /grants", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["GET", "dynamic"]);
  });
});

describe("GET /api/console/cognito/users — auth gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request("http://x/api/console/cognito/users"));
    expect(res.status).toBe(401);
    expect(h.listPoolUsers).not.toHaveBeenCalled();
  });

  test("403 admin-only when authenticated without the admin group", async () => {
    const res = await get({ "x-amzn-oidc-data": marketingToken });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin-only" });
    expect(h.listPoolUsers).not.toHaveBeenCalled();
  });

  test("403 admin-only when the LIVE pool no longer grants admin (revoked token)", async () => {
    h.liveGroupsFor.mockResolvedValue(["marketing"]); // demoted since sign-in
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin-only" });
    // Read path: the cached (60s) live check — only writes force `fresh`.
    expect(h.liveGroupsFor).toHaveBeenCalledWith(
      "amy@nsight.example",
      undefined,
      { fresh: false },
    );
    expect(h.listPoolUsers).not.toHaveBeenCalled();
  });

  test("live-check failure (null) fails OPEN — the token verdict stands", async () => {
    h.liveGroupsFor.mockResolvedValue(null);
    expect((await get()).status).toBe(200);
  });
});

describe("GET /api/console/cognito/users — answers", () => {
  test("200 with pool users merged with their groups", async () => {
    h.liveGroupsFor.mockResolvedValue(["marketing", "marketinghub-admins"]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      users: [
        { ...AMY, groups: ["marketing", "marketinghub-admins"] },
        { ...BOB, groups: ["marketing"] },
      ],
    });
  });

  test("503 + unavailable (honest, logged loud) when the pool call throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.listPoolUsers.mockRejectedValue(new Error("TooManyRequestsException"));
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Cognito pool did not answer.",
      unavailable: true,
    });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      msg: "cognito pool user list failed",
      error: "TooManyRequestsException",
    });
  });

  test("503 + unavailable when COGNITO_USER_POOL_ID is unset (lib throws)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.listPoolUsers.mockRejectedValue(
      new Error("COGNITO_USER_POOL_ID is not configured"),
    );
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).unavailable).toBe(true);
  });
});
