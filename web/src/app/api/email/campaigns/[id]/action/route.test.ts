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

// Mock the server-only bison client; the route is the unit under test.
// BisonApiError is re-declared so the route's instanceof checks hold.
const h = vi.hoisted(() => {
  class BisonApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = "BisonApiError";
    }
  }
  return {
    BisonApiError,
    readConnection: vi.fn(),
    pauseCampaign: vi.fn(),
    resumeCampaign: vi.fn(),
  };
});

vi.mock("@/lib/email/bison", () => ({
  BisonApiError: h.BisonApiError,
  readConnection: h.readConnection,
  pauseCampaign: h.pauseCampaign,
  resumeCampaign: h.resumeCampaign,
}));

// The route reads identity via next/headers (ALB-injected), not the Request.
const hdrs = vi.hoisted(() => ({ current: null as Headers | null }));
vi.mock("next/headers", () => ({
  headers: async () => hdrs.current ?? new Headers(),
}));

import { POST } from "./route";

const CONN = {
  baseUrl: "https://dedi.emailbison.com",
  apiKey: "bison-key",
  workspaceName: "Nsight",
};

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
  hdrs.current = new Headers({ "x-amzn-oidc-data": marketingToken });
  for (const fn of [h.readConnection, h.pauseCampaign, h.resumeCampaign]) {
    fn.mockReset();
  }
  h.readConnection.mockResolvedValue(CONN);
});

afterEach(() => {
  clearAlbEnv();
});

function postReq(body: unknown) {
  return new Request("http://x/api/email/campaigns/7/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Next 15 route context: params is a Promise. */
function ctx(id = "7") {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/email/campaigns/[id]/action", () => {
  test("401 when unauthenticated", async () => {
    hdrs.current = null;
    const res = await POST(postReq({ action: "pause" }), ctx());
    expect(res.status).toBe(401);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    hdrs.current = new Headers({ "x-amzn-oidc-data": viewersToken });
    const res = await POST(postReq({ action: "pause" }), ctx());
    expect(res.status).toBe(403);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
  });

  test.each(["not-a-number", "0", "-3", "1.5", ""])(
    "400 for path id %j, before any bison call",
    async (id) => {
      const res = await POST(postReq({ action: "pause" }), ctx(id));
      expect(res.status).toBe(400);
      expect(h.readConnection).not.toHaveBeenCalled();
      expect(h.pauseCampaign).not.toHaveBeenCalled();
    },
  );

  test("400 on malformed JSON", async () => {
    const res = await POST(postReq("{not json"), ctx());
    expect(res.status).toBe(400);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
  });

  test("400 on an unknown action", async () => {
    const res = await POST(postReq({ action: "explode" }), ctx());
    expect(res.status).toBe(400);
    expect(h.pauseCampaign).not.toHaveBeenCalled();
    expect(h.resumeCampaign).not.toHaveBeenCalled();
  });

  test("409 when EmailBison is not connected", async () => {
    h.readConnection.mockResolvedValue(null);
    const res = await POST(postReq({ action: "pause" }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EmailBison is not connected");
    expect(h.pauseCampaign).not.toHaveBeenCalled();
  });

  test("502 when the connection secret read fails", async () => {
    h.readConnection.mockRejectedValue(new Error("secrets down"));
    const res = await POST(postReq({ action: "resume" }), ctx());
    expect(res.status).toBe(502);
    expect(h.resumeCampaign).not.toHaveBeenCalled();
  });

  test.each([
    ["pause", h.pauseCampaign, h.resumeCampaign],
    ["resume", h.resumeCampaign, h.pauseCampaign],
  ] as const)("%s → 200 {ok, action}", async (action, mock, other) => {
    mock.mockResolvedValue(undefined);
    const res = await POST(postReq({ action }), ctx("42"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action });
    expect(mock).toHaveBeenCalledWith(CONN, 42);
    expect(other).not.toHaveBeenCalled();
  });

  test("502 with the upstream message on BisonApiError", async () => {
    h.pauseCampaign.mockRejectedValue(
      new h.BisonApiError(500, "EmailBison answered 500"),
    );
    const res = await POST(postReq({ action: "pause" }), ctx());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("EmailBison answered 500");
  });

  test("non-Bison action failures rethrow (Next's 500 path)", async () => {
    h.resumeCampaign.mockRejectedValue(new Error("boom"));
    await expect(POST(postReq({ action: "resume" }), ctx())).rejects.toThrow(
      "boom",
    );
  });
});
