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
  runImpersonatedQuery: vi.fn(),
}));

vi.mock("@/lib/console/impersonate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/console/impersonate")>();
  return {
    ...actual, // ImpersonationAuditError stays REAL (instanceof in the route)
    runImpersonatedQuery: h.runImpersonatedQuery,
  };
});

import { ImpersonationAuditError } from "@/lib/console/impersonate";

import { POST } from "./route";

let marketingToken: string;
let viewersToken: string;

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
  h.runImpersonatedQuery.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

const VALID_BODY = {
  email: "target@example.com",
  schema: "marketinghub",
  table: "templates",
  confirm: true,
};

/** What the (mocked) lib hands back — claims only, token as fingerprint. */
const RESULT = {
  claims: {
    role: "authenticated",
    sub: "2adce080-8b98-5721-8d0a-2e8a128aab81",
    email: "target@example.com",
    groups: ["marketing"],
  },
  rows: [{ id: "r1" }],
  rowCount: 1,
  serviceRole: { rows: [{ id: "r1" }, { id: "r2" }], rowCount: 2 },
};

function postReq(
  body: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  },
) {
  return new Request("http://x/api/console/impersonate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/console/impersonate", () => {
  test("401/403 before anything runs (same gate as every console route)", async () => {
    expect((await POST(postReq(VALID_BODY, {}))).status).toBe(401);
    expect(
      (
        await POST(
          postReq(VALID_BODY, {
            "x-amzn-oidc-data": viewersToken,
            "content-type": "application/json",
          }),
        )
      ).status,
    ).toBe(403);
    expect(h.runImpersonatedQuery).not.toHaveBeenCalled();
  });

  test("missing confirm 409s with requiresConfirmation — nothing is minted", async () => {
    const { confirm: _confirm, ...unconfirmed } = VALID_BODY;
    const res = await POST(postReq(unconfirmed));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ requiresConfirmation: true });
    expect(h.runImpersonatedQuery).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON, bad table, out-of-range ttl, or a smuggled role", async () => {
    expect((await POST(postReq("{nope"))).status).toBe(400);
    expect(
      (await POST(postReq({ ...VALID_BODY, table: "Templates; drop" }))).status,
    ).toBe(400);
    expect(
      (await POST(postReq({ ...VALID_BODY, ttlSeconds: 30 }))).status,
    ).toBe(400);
    expect(
      (await POST(postReq({ ...VALID_BODY, ttlSeconds: 3600 }))).status,
    ).toBe(400);
    expect(
      (await POST(postReq({ ...VALID_BODY, schema: "public" }))).status,
    ).toBe(400);
    // Strict body: a role-escalation key is rejected outright.
    expect(
      (await POST(postReq({ ...VALID_BODY, role: "service_role" }))).status,
    ).toBe(400);
    expect(h.runImpersonatedQuery).not.toHaveBeenCalled();
  });

  test("happy path: defaults applied, caller is the auditee, result passes through", async () => {
    h.runImpersonatedQuery.mockResolvedValue(RESULT);

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      claims: { role: "authenticated" },
      rowCount: 1,
      serviceRole: { rowCount: 2 },
    });
    expect(h.runImpersonatedQuery).toHaveBeenCalledWith("amy@nsight.example", {
      email: "target@example.com",
      groups: ["marketing"], // default
      ttlSeconds: 300, // default
      schema: "marketinghub",
      table: "templates",
      limit: 20, // default
      returnToken: undefined,
    });
  });

  test("no raw JWT ever appears in the response body", async () => {
    h.runImpersonatedQuery.mockResolvedValue({
      ...RESULT,
      token: `sha256:${"ab".repeat(32)}`, // the lib's fingerprint form
    });

    const res = await POST(postReq({ ...VALID_BODY, returnToken: true }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    // No three-segment JWS anywhere in the payload.
    expect(raw).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
    const body = JSON.parse(raw) as { token?: string };
    expect(body.token).toMatch(/^sha256:/);
  });

  test("a failed audit insert is a 500 (results never leave unaudited)", async () => {
    h.runImpersonatedQuery.mockRejectedValue(
      new ImpersonationAuditError("relation does not exist"),
    );
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("audit insert");
  });

  test("SUPABASE_JWT_SECRET unset surfaces as 503 (Wave-4 flag off)", async () => {
    h.runImpersonatedQuery.mockRejectedValue(
      new Error(
        "[userJwt] SUPABASE_JWT_SECRET is unset — cannot mint or verify user JWTs.",
      ),
    );
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("SUPABASE_JWT_SECRET");
  });
});
