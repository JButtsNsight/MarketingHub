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
  headerValue: null as string | null,
  readConnection: vi.fn(),
  listReplies: vi.fn(),
}));

// The route reads the ALB identity via next/headers, not the Request.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "x-amzn-oidc-data" ? h.headerValue : null,
    }),
}));

// Partial mock: fns stubbed, BisonApiError stays the REAL class so the
// route's instanceof mapping is exercised.
vi.mock("@/lib/email/bison", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/bison")>();
  return {
    ...actual,
    readConnection: h.readConnection,
    listReplies: h.listReplies,
  };
});

import { BisonApiError } from "@/lib/email/bison";
import { GET } from "./route";

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "mia@nsight.example",
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
  h.headerValue = marketingToken;
  h.readConnection.mockReset();
  h.listReplies.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function req(query = ""): Request {
  return new Request(`http://x/api/email/replies${query}`);
}

const CONN = {
  baseUrl: "https://dedi.emailbison.com",
  apiKey: "9|secret-token",
  workspaceName: "Nsight",
};

const REPLIES_PAGE = {
  replies: [
    {
      id: 11,
      campaignId: 7,
      fromName: "Pat Lee",
      fromEmail: "pat@acme.example",
      subject: "Re: intro",
      body: "Sounds good.",
      dateReceived: "2026-08-13T10:00:00.000000Z",
      folder: "inbox",
      interested: true,
      read: false,
    },
  ],
  meta: { currentPage: 1, lastPage: 3, total: 41 },
};

describe("GET /api/email/replies", () => {
  test("401 when unauthenticated", async () => {
    h.headerValue = null;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(h.readConnection).not.toHaveBeenCalled();
    expect(h.listReplies).not.toHaveBeenCalled();
  });

  test("403 when not in the marketing group", async () => {
    h.headerValue = viewersToken;
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(h.listReplies).not.toHaveBeenCalled();
  });

  test("200 connected:false when EmailBison has never been connected", async () => {
    h.readConnection.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
    expect(h.listReplies).not.toHaveBeenCalled();
  });

  test("502 when the connection secret read fails (outage ≠ not-connected)", async () => {
    h.readConnection.mockRejectedValue(new Error("secrets down"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = await GET(req());
    consoleError.mockRestore();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe(
      "could not read the EmailBison connection",
    );
    expect(h.listReplies).not.toHaveBeenCalled();
  });

  test("200 with replies + meta; defaults folder=inbox, page=1, no status", async () => {
    h.readConnection.mockResolvedValue(CONN);
    h.listReplies.mockResolvedValue(REPLIES_PAGE);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connected).toBe(true);
    expect(json.replies).toEqual(REPLIES_PAGE.replies);
    expect(json.meta).toEqual(REPLIES_PAGE.meta);
    expect(h.listReplies).toHaveBeenCalledWith(CONN, {
      folder: "inbox",
      status: undefined,
      page: 1,
    });
  });

  test("the API key never appears in the response payload", async () => {
    h.readConnection.mockResolvedValue(CONN);
    h.listReplies.mockResolvedValue(REPLIES_PAGE);
    const res = await GET(req());
    expect(await res.text()).not.toContain(CONN.apiKey);
  });

  test("passes through a valid folder, status, and page", async () => {
    h.readConnection.mockResolvedValue(CONN);
    h.listReplies.mockResolvedValue(REPLIES_PAGE);
    const res = await GET(req("?folder=spam&status=interested&page=3"));
    expect(res.status).toBe(200);
    expect(h.listReplies).toHaveBeenCalledWith(CONN, {
      folder: "spam",
      status: "interested",
      page: 3,
    });
  });

  test("unknown folder/status and out-of-range page fall back to defaults", async () => {
    h.readConnection.mockResolvedValue(CONN);
    h.listReplies.mockResolvedValue(REPLIES_PAGE);
    await GET(req("?folder=trash&status=angry&page=0"));
    expect(h.listReplies).toHaveBeenCalledWith(CONN, {
      folder: "inbox",
      status: undefined,
      page: 1,
    });

    await GET(req("?page=10001"));
    expect(h.listReplies).toHaveBeenLastCalledWith(CONN, {
      folder: "inbox",
      status: undefined,
      page: 1,
    });

    await GET(req("?page=2.5"));
    expect(h.listReplies).toHaveBeenLastCalledWith(CONN, {
      folder: "inbox",
      status: undefined,
      page: 1,
    });
  });

  test("502 with the upstream message when EmailBison errors", async () => {
    h.readConnection.mockResolvedValue(CONN);
    h.listReplies.mockRejectedValue(
      new BisonApiError(401, "EmailBison rejected the API token"),
    );
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("EmailBison rejected the API token");
  });
});
