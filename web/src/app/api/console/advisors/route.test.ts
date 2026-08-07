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

// Mock the server-only advisors lib; the route is the unit under test.
const h = vi.hoisted(() => ({ runAdvisors: vi.fn() }));

vi.mock("@/lib/console/advisors", () => ({ runAdvisors: h.runAdvisors }));

import { GET } from "./route";

let marketingToken: string;
let viewersToken: string;

const REPORT = {
  lints: [
    {
      id: "rls_disabled_in_exposed_schema",
      level: "security",
      severity: "error",
      title: "RLS disabled on an exposed table",
      detail: "Table is reachable but RLS is disabled",
      schema: "public",
      object: "leaky",
      remediation: "Enable RLS.",
    },
  ],
  failed: [],
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
  h.runAdvisors.mockReset().mockResolvedValue(REPORT);
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

describe("GET /api/console/advisors", () => {
  test("401 when unauthenticated (no ALB header)", async () => {
    const res = await GET(new Request("http://x/api/console/advisors"));
    expect(res.status).toBe(401);
    expect(h.runAdvisors).not.toHaveBeenCalled();
  });

  test("403 when authenticated but missing the marketing group", async () => {
    const res = await GET(
      new Request("http://x/api/console/advisors", {
        headers: { "x-amzn-oidc-data": viewersToken },
      }),
    );
    expect(res.status).toBe(403);
    expect(h.runAdvisors).not.toHaveBeenCalled();
  });

  test("200 runs the full suite when no level is given", async () => {
    const res = await GET(
      new Request("http://x/api/console/advisors", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(h.runAdvisors).toHaveBeenCalledWith(undefined);
  });

  test("scopes to a single level when ?level= is a known level", async () => {
    await GET(
      new Request("http://x/api/console/advisors?level=security", {
        headers: marketingHeaders(),
      }),
    );
    expect(h.runAdvisors).toHaveBeenCalledWith("security");
  });

  test("treats ?level=all as the full suite (undefined)", async () => {
    await GET(
      new Request("http://x/api/console/advisors?level=all", {
        headers: marketingHeaders(),
      }),
    );
    expect(h.runAdvisors).toHaveBeenCalledWith(undefined);
  });

  test("400 on an unknown level value", async () => {
    const res = await GET(
      new Request("http://x/api/console/advisors?level=bogus", {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.runAdvisors).not.toHaveBeenCalled();
  });

  test("maps a [console:*] failure to 400 with the stripped message", async () => {
    h.runAdvisors.mockRejectedValueOnce(
      new Error("[console:advisors] run failed: pg-meta exploded"),
    );
    const res = await GET(
      new Request("http://x/api/console/advisors", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pg-meta exploded");
  });
});
