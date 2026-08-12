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
  listSecrets: vi.fn(),
  updateSecret: vi.fn(),
  deleteSecret: vi.fn(),
  auditVaultAction: vi.fn(),
}));

vi.mock("@/lib/console/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/vault")>();
  return {
    ...actual,
    listSecrets: h.listSecrets,
    updateSecret: h.updateSecret,
    deleteSecret: h.deleteSecret,
    auditVaultAction: h.auditVaultAction,
  };
});

import { DELETE, PATCH } from "./route";

const ID = "11111111-2222-3333-4444-555555555555";
const UNNAMED_ID = "99999999-8888-7777-6666-555555555555";

const NAMED = {
  id: ID,
  name: "stripe-api-key",
  description: "billing",
  createdAt: "2026-08-08 02:00:00+00",
  updatedAt: "2026-08-08 02:00:00+00",
};
const UNNAMED = {
  id: UNNAMED_ID,
  name: null,
  description: "",
  createdAt: "2026-08-08 02:00:00+00",
  updatedAt: "2026-08-08 02:00:00+00",
};

const PLAINTEXT = "sk_live_SENTINEL_hunter2";

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

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.listSecrets.mockResolvedValue([NAMED, UNNAMED]);
  h.auditVaultAction.mockResolvedValue(undefined);
  h.updateSecret.mockResolvedValue(undefined);
  h.deleteSecret.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAlbEnv();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(
  method: string,
  body?: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  },
) {
  return new Request("http://x/api/console/vault/x", {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

const VALID_PATCH = { name: "stripe-api-key", description: "billing", value: PLAINTEXT };

describe("PATCH /api/console/vault/[id]", () => {
  test("401 unauthenticated / 403 wrong group before any work", async () => {
    expect((await PATCH(req("PATCH", VALID_PATCH, {}), ctx(ID))).status).toBe(401);
    expect(
      (
        await PATCH(
          req("PATCH", VALID_PATCH, {
            "x-amzn-oidc-data": viewersToken,
            "content-type": "application/json",
          }),
          ctx(ID),
        )
      ).status,
    ).toBe(403);
    expect(h.updateSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await PATCH(
      req("PATCH", VALID_PATCH, {
        "x-amzn-oidc-data": marketingToken,
        "content-type": "application/json",
      }),
      ctx(ID),
    );
    expect(forbidden.status).toBe(403);
    expect(h.updateSecret).not.toHaveBeenCalled();

    const admin = await PATCH(
      req("PATCH", VALID_PATCH, {
        "x-amzn-oidc-data": adminToken,
        "content-type": "application/json",
      }),
      ctx(ID),
    );
    expect(admin.status).toBe(200);
  });

  test("404 on a non-uuid path id without touching the data layer", async () => {
    const res = await PATCH(req("PATCH", VALID_PATCH), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.updateSecret).not.toHaveBeenCalled();
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  test("404 when the secret does not exist — no silent zero-row update", async () => {
    h.listSecrets.mockResolvedValue([]);
    const res = await PATCH(req("PATCH", VALID_PATCH), ctx(ID));
    expect(res.status).toBe(404);
    expect(h.updateSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("updates (lowercased id) and audits METADATA ONLY, no-store", async () => {
    const res = await PATCH(
      req("PATCH", { name: "  renamed  ", description: "d2", value: PLAINTEXT }),
      ctx(ID.toUpperCase()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ updated: true });
    expect(h.updateSecret).toHaveBeenCalledWith(ID, {
      name: "renamed",
      description: "d2",
      value: PLAINTEXT,
    });
    expect(h.auditVaultAction).toHaveBeenCalledWith({
      secretId: ID,
      secretName: "renamed",
      actor: "amy@nsight.example",
      action: "update",
    });
    expect(JSON.stringify(h.auditVaultAction.mock.calls)).not.toContain(
      PLAINTEXT,
    );
  });

  test("400 when value is missing — vault.update_secret replaces, never patches", async () => {
    const res = await PATCH(
      req("PATCH", { name: "renamed", description: "d2" }),
      ctx(ID),
    );
    expect(res.status).toBe(400);
    expect(h.updateSecret).not.toHaveBeenCalled();
  });

  test("a sanitized [console:vault] failure maps to 400 and audits nothing", async () => {
    h.updateSecret.mockRejectedValue(new Error("[console:vault] update failed"));
    const res = await PATCH(req("PATCH", VALID_PATCH), ctx(ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("update failed");
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/console/vault/[id]", () => {
  test("403 for the wrong group before deleting", async () => {
    const res = await DELETE(
      req(
        "DELETE",
        { confirm: "stripe-api-key" },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
      ctx(ID),
    );
    expect(res.status).toBe(403);
    expect(h.deleteSecret).not.toHaveBeenCalled();
  });

  test("404 on a non-uuid path id / unknown secret", async () => {
    expect(
      (await DELETE(req("DELETE", { confirm: "x" }), ctx("nope"))).status,
    ).toBe(404);
    h.listSecrets.mockResolvedValue([]);
    expect(
      (await DELETE(req("DELETE", { confirm: "stripe-api-key" }), ctx(ID)))
        .status,
    ).toBe(404);
    expect(h.deleteSecret).not.toHaveBeenCalled();
  });

  test("SERVER-enforced typed-name confirm: a bare body cannot delete", async () => {
    const res = await DELETE(req("DELETE", {}), ctx(ID));
    expect(res.status).toBe(400);
    expect(h.deleteSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("SERVER-enforced typed-name confirm: a wrong echo cannot delete", async () => {
    const res = await DELETE(req("DELETE", { confirm: "stripe-api-ke" }), ctx(ID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "confirm must match the secret name exactly",
    );
    expect(h.deleteSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("confirm is checked against SERVER truth, not the client's claim", async () => {
    // The stored name is "stripe-api-key"; echoing some other secret's name
    // (or anything the client invents) must be refused.
    const res = await DELETE(req("DELETE", { confirm: "whatever-i-say" }), ctx(ID));
    expect(res.status).toBe(400);
    expect(h.deleteSecret).not.toHaveBeenCalled();
  });

  test("deletes with the exact name echo and audits metadata only", async () => {
    const res = await DELETE(
      req("DELETE", { confirm: "stripe-api-key" }),
      ctx(ID),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ deleted: true });
    expect(h.deleteSecret).toHaveBeenCalledWith(ID);
    expect(h.auditVaultAction).toHaveBeenCalledWith({
      secretId: ID,
      secretName: "stripe-api-key",
      actor: "amy@nsight.example",
      action: "delete",
    });
  });

  test("an unnamed secret confirms by its id", async () => {
    expect(
      (await DELETE(req("DELETE", { confirm: "unnamed" }), ctx(UNNAMED_ID)))
        .status,
    ).toBe(400);
    expect(h.deleteSecret).not.toHaveBeenCalled();

    const res = await DELETE(
      req("DELETE", { confirm: UNNAMED_ID }),
      ctx(UNNAMED_ID),
    );
    expect(res.status).toBe(200);
    expect(h.deleteSecret).toHaveBeenCalledWith(UNNAMED_ID);
  });
});
