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
    createCampaign: vi.fn(),
  };
});

vi.mock("@/lib/email/bison", () => ({
  BisonApiError: h.BisonApiError,
  readConnection: h.readConnection,
  createCampaign: h.createCampaign,
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
  h.readConnection.mockReset();
  h.createCampaign.mockReset();
  h.readConnection.mockResolvedValue(CONN);
});

afterEach(() => {
  clearAlbEnv();
});

function postReq(body: unknown) {
  return new Request("http://x/api/email/campaigns/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/email/campaigns/create", () => {
  test("401 when unauthenticated", async () => {
    hdrs.current = null;
    const res = await POST(postReq({ name: "Q4 Outreach" }));
    expect(res.status).toBe(401);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    hdrs.current = new Headers({ "x-amzn-oidc-data": viewersToken });
    const res = await POST(postReq({ name: "Q4 Outreach" }));
    expect(res.status).toBe(403);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("400 on malformed JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", {}],
    ["non-string", { name: 7 }],
    ["blank after trim", { name: "   " }],
    ["over 200 chars", { name: "x".repeat(201) }],
  ])("400 for a %s name, before any bison call", async (_label, body) => {
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(h.readConnection).not.toHaveBeenCalled();
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("409 when EmailBison is not connected", async () => {
    h.readConnection.mockResolvedValue(null);
    const res = await POST(postReq({ name: "Q4 Outreach" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("EmailBison is not connected");
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("502 when the connection secret read fails", async () => {
    h.readConnection.mockRejectedValue(new Error("secrets down"));
    const res = await POST(postReq({ name: "Q4 Outreach" }));
    expect(res.status).toBe(502);
    expect(h.createCampaign).not.toHaveBeenCalled();
  });

  test("200 with the created campaign; name is trimmed", async () => {
    h.createCampaign.mockResolvedValue({
      id: 12,
      name: "Q4 Outreach",
      status: "Draft",
    });
    const res = await POST(postReq({ name: "  Q4 Outreach  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 12,
      name: "Q4 Outreach",
      status: "Draft",
    });
    expect(h.createCampaign).toHaveBeenCalledWith(CONN, "Q4 Outreach");
  });

  test("a 200-char name passes the gate", async () => {
    const name = "x".repeat(200);
    h.createCampaign.mockResolvedValue({ id: 13, name, status: "Draft" });
    const res = await POST(postReq({ name }));
    expect(res.status).toBe(200);
  });

  test("502 with the upstream message on BisonApiError", async () => {
    h.createCampaign.mockRejectedValue(
      new h.BisonApiError(401, "EmailBison rejected the API token"),
    );
    const res = await POST(postReq({ name: "Q4 Outreach" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("EmailBison rejected the API token");
  });

  test("non-Bison create failures rethrow (Next's 500 path)", async () => {
    h.createCampaign.mockRejectedValue(new Error("boom"));
    await expect(POST(postReq({ name: "Q4 Outreach" }))).rejects.toThrow(
      "boom",
    );
  });
});
