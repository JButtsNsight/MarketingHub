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
  setInboundHandled: vi.fn(),
  // Sentinel client threaded by the route into every repo call (Wave 4).
  userDb: {},
}));

vi.mock("@/lib/sms/repo", () => ({
  setInboundHandled: h.setInboundHandled,
}));
vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => h.userDb,
}));

import { PATCH } from "./route";

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
  h.setInboundHandled.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

const MESSAGE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function ctx(id: string = MESSAGE_ID) {
  return { params: Promise.resolve({ id }) };
}

function patchReq(
  body: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  },
) {
  return new Request(`http://x/api/inbox/${MESSAGE_ID}`, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/inbox/[id]", () => {
  test("401 when unauthenticated / 403 outside the marketing group", async () => {
    expect(
      (
        await PATCH(
          patchReq({ handled: true }, { "content-type": "application/json" }),
          ctx(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await PATCH(
          patchReq(
            { handled: true },
            {
              "x-amzn-oidc-data": viewersToken,
              "content-type": "application/json",
            },
          ),
          ctx(),
        )
      ).status,
    ).toBe(403);
    expect(h.setInboundHandled).not.toHaveBeenCalled();
  });

  test("404 (not 500) for a non-UUID id, before any repo call", async () => {
    const res = await PATCH(patchReq({ handled: true }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.setInboundHandled).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON and on a non-boolean handled", async () => {
    expect((await PATCH(patchReq("{not json"), ctx())).status).toBe(400);
    expect((await PATCH(patchReq({ handled: "yes" }), ctx())).status).toBe(400);
    expect(h.setInboundHandled).not.toHaveBeenCalled();
  });

  test("200 flips the workflow bit with the caller as actor", async () => {
    const message = { id: MESSAGE_ID, handled: true };
    h.setInboundHandled.mockResolvedValue(message);

    const res = await PATCH(patchReq({ handled: true }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message });
    expect(h.setInboundHandled).toHaveBeenCalledWith(
      MESSAGE_ID,
      true,
      "amy@nsight.example",
      h.userDb,
    );
  });

  test("404 for an unknown message", async () => {
    h.setInboundHandled.mockResolvedValue(null);
    const res = await PATCH(patchReq({ handled: false }), ctx());
    expect(res.status).toBe(404);
  });
});
