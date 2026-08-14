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
  addToGroup: vi.fn(),
  removeFromGroup: vi.fn(),
  liveGroupsFor: vi.fn(),
}));

vi.mock("@/lib/cognitoAdmin", () => ({
  listPoolUsers: h.listPoolUsers,
  addToGroup: h.addToGroup,
  removeFromGroup: h.removeFromGroup,
  liveGroupsFor: h.liveGroupsFor,
}));

import * as routeModule from "./route";
import { POST } from "./route";

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
  h.addToGroup.mockReset().mockResolvedValue(undefined);
  h.removeFromGroup.mockReset().mockResolvedValue(undefined);
  h.liveGroupsFor.mockReset().mockResolvedValue(null); // live check unavailable
});

afterEach(() => {
  clearAlbEnv();
  vi.restoreAllMocks();
});

function post(
  body: unknown,
  headers: HeadersInit = { "x-amzn-oidc-data": adminToken },
) {
  return POST(
    new Request("http://x/api/console/cognito/grants", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/console/cognito/grants — export surface", () => {
  test("POST is the only verb", () => {
    expect(Object.keys(routeModule).sort()).toEqual(["POST", "dynamic"]);
  });
});

describe("POST /api/console/cognito/grants — auth gate", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await POST(
      new Request("http://x/api/console/cognito/grants", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(h.addToGroup).not.toHaveBeenCalled();
  });

  test("403 admin-only when authenticated without the admin group", async () => {
    const res = await post(
      { username: "u-bob", group: "marketing", action: "add" },
      { "x-amzn-oidc-data": marketingToken },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin-only" });
    expect(h.addToGroup).not.toHaveBeenCalled();
  });

  test("403 admin-only when the LIVE pool no longer grants admin — no stale-token grants", async () => {
    h.liveGroupsFor.mockResolvedValue(["marketing"]); // demoted since sign-in
    const res = await post({
      username: "u-bob",
      group: "marketinghub-admins",
      action: "add",
    });
    expect(res.status).toBe(403);
    expect(h.addToGroup).not.toHaveBeenCalled();
  });

  test("the write path's live check is UNCACHED — out-of-band revocation can't ride the 60s cache", async () => {
    await post({ username: "u-bob", group: "marketing", action: "add" });
    expect(h.liveGroupsFor).toHaveBeenCalledWith(
      "amy@nsight.example",
      undefined, // the lib's own client
      { fresh: true },
    );
  });
});

describe("POST /api/console/cognito/grants — validation", () => {
  test("400 on invalid JSON", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  test("400 when the group is outside the fixed registry — never reaches the pool", async () => {
    const res = await post({
      username: "u-bob",
      group: "made-up-group",
      action: "add",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    expect(h.addToGroup).not.toHaveBeenCalled();
    expect(h.listPoolUsers).not.toHaveBeenCalled();
  });

  test("400 on an unknown action", async () => {
    const res = await post({
      username: "u-bob",
      group: "marketing",
      action: "grant",
    });
    expect(res.status).toBe(400);
  });

  test("400 on a blank username", async () => {
    const res = await post({ username: "  ", group: "marketing", action: "add" });
    expect(res.status).toBe(400);
  });

  test("404 when the username is not in the pool", async () => {
    const res = await post({
      username: "u-ghost",
      group: "marketing",
      action: "add",
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("No user with that username");
    expect(h.addToGroup).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/cognito/grants — own-god-mode guard", () => {
  test("403 when the actor removes their OWN god-mode — mutation never sent", async () => {
    const res = await post({
      username: "u-amy", // amy acting on amy
      group: "marketinghub-admins",
      action: "remove",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "You can't remove your own god-mode.",
    );
    expect(h.removeFromGroup).not.toHaveBeenCalled();
  });

  test("403 when the actor ADDS their own god-mode — self-escalation guard, mutation never sent", async () => {
    // No legitimate use: a real admin already holds the group; a stale one
    // (out-of-band revocation + fail-open live check) would re-admin themselves.
    h.liveGroupsFor.mockResolvedValue(null); // live check unavailable — fail-open path
    const res = await post({
      username: "u-amy",
      group: "marketinghub-admins",
      action: "add",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You can't grant your own god-mode.");
    expect(h.addToGroup).not.toHaveBeenCalled();
  });

  test("email compare is case-insensitive", async () => {
    h.listPoolUsers.mockResolvedValue([
      { ...AMY, email: "AMY@Nsight.example" },
      BOB,
    ]);
    const res = await post({
      username: "u-amy",
      group: "marketinghub-admins",
      action: "remove",
    });
    expect(res.status).toBe(403);
    expect(h.removeFromGroup).not.toHaveBeenCalled();
  });

  test("guards ONLY own god-mode: removing another admin's god-mode is allowed", async () => {
    const res = await post({
      username: "u-bob",
      group: "marketinghub-admins",
      action: "remove",
    });
    expect(res.status).toBe(200);
    expect(h.removeFromGroup).toHaveBeenCalledWith(
      "u-bob",
      "marketinghub-admins",
    );
  });

  test("guards ONLY god-mode: the actor may remove their own section group", async () => {
    const res = await post({
      username: "u-amy",
      group: "mh-section-platform",
      action: "remove",
    });
    expect(res.status).toBe(200);
    expect(h.removeFromGroup).toHaveBeenCalledWith("u-amy", "mh-section-platform");
  });
});

describe("POST /api/console/cognito/grants — applied changes", () => {
  test("add grants the group and logs the structured audit line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({
      username: "u-bob",
      group: "mh-section-intel",
      action: "add",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.addToGroup).toHaveBeenCalledWith("u-bob", "mh-section-intel");
    expect(h.removeFromGroup).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      msg: "cognito group grant",
      actor: "amy@nsight.example",
      target: "bob@nsight.example",
      username: "u-bob",
      group: "mh-section-intel",
      action: "add",
    });
  });

  test("remove revokes the group and logs the structured audit line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post({
      username: "u-bob",
      group: "marketing",
      action: "remove",
    });
    expect(res.status).toBe(200);
    expect(h.removeFromGroup).toHaveBeenCalledWith("u-bob", "marketing");
    expect(h.addToGroup).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      action: "remove",
      group: "marketing",
    });
  });

  test("503 + loud log when the pool mutation throws — nothing audited as applied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    h.addToGroup.mockRejectedValue(new Error("ServiceUnavailable"));
    const res = await post({
      username: "u-bob",
      group: "marketing",
      action: "add",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Cognito pool did not answer.",
      unavailable: true,
    });
    expect(log).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      msg: "cognito group grant failed",
      error: "ServiceUnavailable",
    });
  });
});

describe("Prime Admin protection", () => {
  const PRIME = {
    username: "GoogleSAML_jbutts@nsightcare.com",
    email: "jbutts@nsightcare.com",
    status: "EXTERNAL_PROVIDER",
    created: "2026-08-12T00:00:00.000Z",
    enabled: true,
  };
  let primeToken: string;

  beforeAll(async () => {
    primeToken = await signAlbToken({
      email: "jbutts@nsightcare.com",
      name: "Justin",
      "cognito:groups": ["marketing", "marketinghub-admins"],
    });
  });

  beforeEach(() => {
    h.listPoolUsers.mockResolvedValue([AMY, BOB, PRIME]);
  });

  test("403 when ANY other admin touches the Prime Admin — both actions, mutation never sent", async () => {
    for (const action of ["add", "remove"] as const) {
      const res = await post({
        username: PRIME.username,
        group: "mh-section-intel",
        action,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/prime admin/i);
    }
    expect(h.addToGroup).not.toHaveBeenCalled();
    expect(h.removeFromGroup).not.toHaveBeenCalled();
  });

  test("even the Prime Admin's GOD-MODE is untouchable by others (not just sections)", async () => {
    const res = await post({
      username: PRIME.username,
      group: "marketinghub-admins",
      action: "remove",
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/prime admin/i);
    expect(h.removeFromGroup).not.toHaveBeenCalled();
  });

  test("the Prime Admin may still modify their own account (sections; own god-mode stays self-guarded)", async () => {
    const ok = await post(
      { username: PRIME.username, group: "mh-section-intel", action: "add" },
      { "x-amzn-oidc-data": primeToken },
    );
    expect(ok.status).toBe(200);
    expect(h.addToGroup).toHaveBeenCalledWith(PRIME.username, "mh-section-intel");

    const guarded = await post(
      { username: PRIME.username, group: "marketinghub-admins", action: "remove" },
      { "x-amzn-oidc-data": primeToken },
    );
    expect(guarded.status).toBe(403);
    expect((await guarded.json()).error).toMatch(/own god-mode/i);
  });
});
