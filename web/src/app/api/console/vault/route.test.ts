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
  createSecret: vi.fn(),
  revealSecret: vi.fn(),
  auditVaultAction: vi.fn(),
}));

vi.mock("@/lib/console/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/vault")>();
  return {
    ...actual,
    listSecrets: h.listSecrets,
    createSecret: h.createSecret,
    revealSecret: h.revealSecret,
    auditVaultAction: h.auditVaultAction,
  };
});

import { GET, POST } from "./route";

const META = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "stripe-api-key",
  description: "billing",
  createdAt: "2026-08-08 02:00:00+00",
  updatedAt: "2026-08-08 02:00:00+00",
};

// A sentinel plaintext that must NEVER appear in list responses or audit args.
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
  h.listSecrets.mockResolvedValue([META]);
  h.auditVaultAction.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAlbEnv();
});

function req(
  method: string,
  body?: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
  },
) {
  return new Request("http://x/api/console/vault", {
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

describe("GET /api/console/vault (list)", () => {
  test("401 unauthenticated / 403 wrong group before any read", async () => {
    expect((await GET(req("GET", undefined, {}))).status).toBe(401);
    expect(
      (
        await GET(req("GET", undefined, { "x-amzn-oidc-data": viewersToken }))
      ).status,
    ).toBe(403);
    expect(h.listSecrets).not.toHaveBeenCalled();
    expect(h.revealSecret).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (
        await GET(req("GET", undefined, { "x-amzn-oidc-data": marketingToken }))
      ).status,
    ).toBe(403);
    expect(h.listSecrets).not.toHaveBeenCalled();
    expect(
      (
        await GET(req("GET", undefined, { "x-amzn-oidc-data": adminToken }))
      ).status,
    ).toBe(200);
  });

  test("returns metadata only, never calls the reveal path, no-store", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ secrets: [META] });
    // Listing must be structurally incapable of decrypting.
    expect(h.revealSecret).not.toHaveBeenCalled();
  });

  test("listing is a read — no audit row", async () => {
    await GET(req("GET"));
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("maps a [console:vault] failure to 400 with the sanitized message", async () => {
    h.listSecrets.mockRejectedValue(new Error("[console:vault] list failed"));
    const res = await GET(req("GET"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("list failed");
  });
});

describe("POST /api/console/vault (create)", () => {
  const NEW_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  test("403 for the wrong group before creating", async () => {
    const res = await POST(
      req(
        "POST",
        { name: "k", value: PLAINTEXT },
        { "x-amzn-oidc-data": viewersToken, "content-type": "application/json" },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("creates and audits METADATA ONLY — the value never reaches audit", async () => {
    h.createSecret.mockResolvedValue(NEW_ID);
    const res = await POST(
      req("POST", { name: "  new-key  ", description: "d", value: PLAINTEXT }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: NEW_ID });
    // zod trims the name before it reaches the data layer.
    expect(h.createSecret).toHaveBeenCalledWith({
      name: "new-key",
      description: "d",
      value: PLAINTEXT,
    });

    expect(h.auditVaultAction).toHaveBeenCalledTimes(1);
    expect(h.auditVaultAction).toHaveBeenCalledWith({
      secretId: NEW_ID,
      secretName: "new-key",
      actor: "amy@nsight.example",
      action: "create",
    });
    // The load-bearing invariant: nothing passed to the audit path carries
    // the plaintext, under any key.
    expect(JSON.stringify(h.auditVaultAction.mock.calls)).not.toContain(
      PLAINTEXT,
    );
  });

  test("400 on a missing name/value without touching the data layer", async () => {
    expect(
      (await POST(req("POST", { name: "", value: PLAINTEXT }))).status,
    ).toBe(400);
    expect((await POST(req("POST", { name: "k" }))).status).toBe(400);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON", async () => {
    expect((await POST(req("POST", "{nope"))).status).toBe(400);
    expect(h.createSecret).not.toHaveBeenCalled();
  });

  test("a sanitized [console:vault] failure maps to 400, audits nothing, leaks nothing", async () => {
    h.createSecret.mockRejectedValue(new Error("[console:vault] create failed"));
    const res = await POST(req("POST", { name: "k", value: PLAINTEXT }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("create failed");
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
    expect(h.auditVaultAction).not.toHaveBeenCalled();
  });
});
