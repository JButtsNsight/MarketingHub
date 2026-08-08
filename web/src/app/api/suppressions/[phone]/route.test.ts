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

// Mock the server-only repo; the route is the unit under test.
const h = vi.hoisted(() => ({
  getSuppression: vi.fn(),
  removeManualSuppression: vi.fn(),
}));

// Sentinel client threaded by the route into every repo call (Wave 4).
const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/sms/repo", () => ({
  getSuppression: h.getSuppression,
  removeManualSuppression: h.removeManualSuppression,
}));
vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
}));

import { DELETE } from "./route";

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
  for (const fn of Object.values(h)) fn.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

const PHONE = "+15550000006";

function ctx(phone: string = encodeURIComponent(PHONE)) {
  return { params: Promise.resolve({ phone }) };
}

function deleteReq(headers: HeadersInit = { "x-amzn-oidc-data": marketingToken }) {
  return new Request(
    `http://x/api/suppressions/${encodeURIComponent(PHONE)}`,
    { method: "DELETE", headers },
  );
}

const MANUAL = {
  phone_e164: PHONE,
  reason: "manual",
  raw: { added_by: "amy@nsight.example", note: null },
  created_at: "2026-08-05T12:00:00Z",
};

describe("DELETE /api/suppressions/[phone]", () => {
  test("401 when unauthenticated / 403 outside the marketing group", async () => {
    expect((await DELETE(deleteReq({}), ctx())).status).toBe(401);
    expect(
      (
        await DELETE(deleteReq({ "x-amzn-oidc-data": viewersToken }), ctx())
      ).status,
    ).toBe(403);
    expect(h.removeManualSuppression).not.toHaveBeenCalled();
  });

  test("404 for an un-normalizable phone param, before any repo call", async () => {
    const res = await DELETE(deleteReq(), ctx("123"));
    expect(res.status).toBe(404);
    expect(h.getSuppression).not.toHaveBeenCalled();
  });

  test("404 when the phone is not on the list", async () => {
    h.getSuppression.mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(404);
    expect(h.removeManualSuppression).not.toHaveBeenCalled();
  });

  test("409 for a webhook STOP entry — permanent by doctrine", async () => {
    h.getSuppression.mockResolvedValue({ ...MANUAL, reason: "stop" });
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/permanent/i);
    expect(h.removeManualSuppression).not.toHaveBeenCalled();
  });

  test("204 on a manual removal, actor passed through for the audit row", async () => {
    h.getSuppression.mockResolvedValue(MANUAL);
    h.removeManualSuppression.mockResolvedValue(MANUAL);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(204);
    expect(h.removeManualSuppression).toHaveBeenCalledWith(
      PHONE,
      "amy@nsight.example",
      undefined,
      userDb,
    );
  });

  test("404 when the removal race is lost after the read", async () => {
    h.getSuppression.mockResolvedValue(MANUAL);
    h.removeManualSuppression.mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(404);
  });
});
