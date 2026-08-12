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
  revealSecret: vi.fn(),
  auditVaultActionOrThrow: vi.fn(),
}));

vi.mock("@/lib/console/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/vault")>();
  return {
    ...actual,
    listSecrets: h.listSecrets,
    revealSecret: h.revealSecret,
    auditVaultActionOrThrow: h.auditVaultActionOrThrow,
  };
});

import * as route from "./route";

const { POST } = route;

const ID = "11111111-2222-3333-4444-555555555555";
const META = {
  id: ID,
  name: "stripe-api-key",
  description: "billing",
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
  h.listSecrets.mockResolvedValue([META]);
  h.revealSecret.mockResolvedValue(PLAINTEXT);
  h.auditVaultActionOrThrow.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAlbEnv();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(headers: HeadersInit = { "x-amzn-oidc-data": platformToken }) {
  return new Request(`http://x/api/console/vault/${ID}/reveal`, {
    method: "POST",
    headers,
  });
}

describe("POST /api/console/vault/[id]/reveal", () => {
  test("the module is POST-only — no readable/other verb is exported", () => {
    // A GET would make the plaintext link-followable and prefetchable.
    const verbs = route as Record<string, unknown>;
    expect(verbs.GET).toBeUndefined();
    expect(verbs.HEAD).toBeUndefined();
    expect(verbs.PUT).toBeUndefined();
    expect(verbs.PATCH).toBeUndefined();
    expect(verbs.DELETE).toBeUndefined();
    expect(typeof verbs.POST).toBe("function");
  });

  test("401 unauthenticated / 403 wrong group before any decrypt", async () => {
    expect((await POST(req({}), ctx(ID))).status).toBe(401);
    expect(
      (await POST(req({ "x-amzn-oidc-data": viewersToken }), ctx(ID))).status,
    ).toBe(403);
    expect(h.revealSecret).not.toHaveBeenCalled();
    expect(h.auditVaultActionOrThrow).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    expect(
      (await POST(req({ "x-amzn-oidc-data": marketingToken }), ctx(ID))).status,
    ).toBe(403);
    expect(h.revealSecret).not.toHaveBeenCalled();
    expect(
      (await POST(req({ "x-amzn-oidc-data": adminToken }), ctx(ID))).status,
    ).toBe(200);
  });

  test("404 on a non-uuid id / unknown secret — never a decrypt attempt", async () => {
    expect((await POST(req(), ctx("not-a-uuid"))).status).toBe(404);
    h.listSecrets.mockResolvedValue([]);
    expect((await POST(req(), ctx(ID))).status).toBe(404);
    expect(h.revealSecret).not.toHaveBeenCalled();
    expect(h.auditVaultActionOrThrow).not.toHaveBeenCalled();
  });

  test("reveals one id-filtered value under no-store; audit is METADATA ONLY and lands FIRST", async () => {
    const res = await POST(req(), ctx(ID.toUpperCase()));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ value: PLAINTEXT });
    expect(h.revealSecret).toHaveBeenCalledTimes(1);
    expect(h.revealSecret).toHaveBeenCalledWith(ID);

    expect(h.auditVaultActionOrThrow).toHaveBeenCalledTimes(1);
    expect(h.auditVaultActionOrThrow).toHaveBeenCalledWith({
      secretId: ID,
      secretName: "stripe-api-key",
      actor: "amy@nsight.example",
      action: "reveal",
    });
    // Fail-closed ordering: the audit row is a PRECONDITION of the decrypt.
    expect(
      h.auditVaultActionOrThrow.mock.invocationCallOrder[0],
    ).toBeLessThan(h.revealSecret.mock.invocationCallOrder[0]);
    // The load-bearing invariant: the audit path never sees the plaintext.
    expect(
      JSON.stringify(h.auditVaultActionOrThrow.mock.calls),
    ).not.toContain(PLAINTEXT);
  });

  test("audit-insert failure REFUSES the reveal: 400, no decrypt, no plaintext", async () => {
    // The pre-migration deploy window (vault_console_audit missing) and any
    // later audit breakage land here — fail-closed by contract.
    h.auditVaultActionOrThrow.mockRejectedValue(
      new Error(
        "[console:vault] reveal failed: the audit log is unavailable — refusing an unaudited reveal",
      ),
    );
    const res = await POST(req(), ctx(ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "reveal failed: the audit log is unavailable — refusing an unaudited reveal",
    );
    expect(h.revealSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
  });

  test("a sanitized decrypt failure maps to 400 and leaks nothing (attempt already audited)", async () => {
    h.revealSecret.mockRejectedValue(new Error("[console:vault] reveal failed"));
    const res = await POST(req(), ctx(ID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("reveal failed");
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT);
    // Audit-first means the failed ATTEMPT is on the record — by design.
    expect(h.auditVaultActionOrThrow).toHaveBeenCalledTimes(1);
  });
});
