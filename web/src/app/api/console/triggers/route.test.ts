// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
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

const h = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  setTriggerEnabled: vi.fn(),
  dropTrigger: vi.fn(),
}));

vi.mock("@/lib/console/dbobjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/dbobjects")>();
  return {
    ...actual,
    listTriggers: h.listTriggers,
    setTriggerEnabled: h.setTriggerEnabled,
    dropTrigger: h.dropTrigger,
  };
});

import { DELETE, GET, PATCH } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

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

const TRIGGER = {
  oid: 42,
  schema: "marketinghub",
  table: "templates",
  name: "set_updated_at",
  enabled: true,
  definition:
    "CREATE TRIGGER set_updated_at BEFORE UPDATE ON marketinghub.templates FOR EACH ROW EXECUTE FUNCTION marketinghub.touch_updated_at()",
};

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.listTriggers.mockResolvedValue([TRIGGER]);
  h.setTriggerEnabled.mockResolvedValue(undefined);
  h.dropTrigger.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAlbEnv();
});

function sectionHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  };
}

function getReq(headers: HeadersInit = sectionHeaders()) {
  return new Request("http://x/api/console/triggers", { headers });
}

function bodyReq(
  method: string,
  body: unknown,
  headers: HeadersInit = sectionHeaders(),
) {
  return new Request("http://x/api/console/triggers", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/console/triggers", () => {
  test("401/403 before any introspection", async () => {
    expect((await GET(getReq({}))).status).toBe(401);
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": viewersToken }))).status,
    ).toBe(403);
    expect(h.listTriggers).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": marketingToken }))).status,
    ).toBe(403);
    expect(h.listTriggers).not.toHaveBeenCalled();
    expect(
      (await GET(getReq({ "x-amzn-oidc-data": adminToken }))).status,
    ).toBe(200);
  });

  test("200 returns the live trigger list", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ triggers: [TRIGGER] });
  });
});

describe("PATCH /api/console/triggers", () => {
  test("403 for a user without the section before any write", async () => {
    const res = await PATCH(
      bodyReq(
        "PATCH",
        { schema: "marketinghub", table: "templates", name: "set_updated_at", enabled: false },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.setTriggerEnabled).not.toHaveBeenCalled();
  });

  test("toggles enabled state by structured schema/table/name", async () => {
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "marketinghub",
        table: "templates",
        name: "set_updated_at",
        enabled: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enabled: false });
    expect(h.setTriggerEnabled).toHaveBeenCalledWith(
      "marketinghub",
      "templates",
      "set_updated_at",
      false,
    );
  });

  test("400 on an invalid identifier — never reaches the lib", async () => {
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "marketinghub",
        table: "bad table",
        name: "set_updated_at",
        enabled: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(h.setTriggerEnabled).not.toHaveBeenCalled();
  });

  test("400 with the real Postgres message on a [console:dbobjects] failure", async () => {
    h.setTriggerEnabled.mockRejectedValue(
      new Error(
        "[console:dbobjects] set-trigger-enabled failed: trigger marketinghub.templates.set_updated_at does not exist",
      ),
    );
    const res = await PATCH(
      bodyReq("PATCH", {
        schema: "marketinghub",
        table: "templates",
        name: "set_updated_at",
        enabled: true,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("trigger marketinghub.templates.set_updated_at does not exist");
  });
});

describe("DELETE /api/console/triggers", () => {
  test("drops by structured schema/table/name", async () => {
    const res = await DELETE(
      bodyReq("DELETE", {
        schema: "marketinghub",
        table: "templates",
        name: "set_updated_at",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.dropTrigger).toHaveBeenCalledWith(
      "marketinghub",
      "templates",
      "set_updated_at",
    );
  });

  test("400 on a missing field, 400 on invalid JSON — never reaches the lib", async () => {
    expect(
      (
        await DELETE(
          bodyReq("DELETE", { schema: "marketinghub", table: "templates" }),
        )
      ).status,
    ).toBe(400);
    expect((await DELETE(bodyReq("DELETE", "not json"))).status).toBe(400);
    expect(h.dropTrigger).not.toHaveBeenCalled();
  });
});
