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
  runConsoleQuery: vi.fn(),
  listHistory: vi.fn(),
}));

vi.mock("@/lib/console/sql", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/sql")>();
  return {
    ...actual, // classifySql stays REAL — the confirm handshake is under test
    runConsoleQuery: h.runConsoleQuery,
    listHistory: h.listHistory,
  };
});

import { GET, POST } from "./route";

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
  h.listHistory.mockResolvedValue([]);
});

afterEach(() => {
  clearAlbEnv();
});

function postReq(
  body: unknown,
  headers: HeadersInit = {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  },
) {
  return new Request("http://x/api/console/sql", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/console/sql", () => {
  test("401/403 before anything runs", async () => {
    expect((await POST(postReq({ sql: "select 1" }, {}))).status).toBe(401);
    expect(
      (
        await POST(
          postReq(
            { sql: "select 1" },
            {
              "x-amzn-oidc-data": viewersToken,
              "content-type": "application/json",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(h.runConsoleQuery).not.toHaveBeenCalled();
  });

  test("read statements run immediately with the caller as auditee", async () => {
    h.runConsoleQuery.mockResolvedValue({
      rows: [{ ok: 1 }],
      rowCount: 1,
      truncated: false,
      durationMs: 12,
      classification: "read",
    });
    const res = await POST(postReq({ sql: "select 1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rowCount: 1 });
    expect(h.runConsoleQuery).toHaveBeenCalledWith(
      "select 1",
      "amy@nsight.example",
    );
  });

  test("write statements 409 with requiresConfirmation until confirmed", async () => {
    const res = await POST(
      postReq({ sql: "update marketinghub.templates set name = 'x'" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ requiresConfirmation: true });
    expect(h.runConsoleQuery).not.toHaveBeenCalled();

    h.runConsoleQuery.mockResolvedValue({
      rows: [],
      rowCount: 0,
      truncated: false,
      durationMs: 5,
      classification: "write",
    });
    const confirmed = await POST(
      postReq({
        sql: "update marketinghub.templates set name = 'x'",
        confirmWrite: true,
      }),
    );
    expect(confirmed.status).toBe(200);
    expect(h.runConsoleQuery).toHaveBeenCalledTimes(1);
  });

  test("Postgres errors surface as 400 with the real message", async () => {
    h.runConsoleQuery.mockRejectedValue(
      new Error(
        '[console:pgmeta] query failed: 400: relation "nope" does not exist',
      ),
    );
    const res = await POST(postReq({ sql: "select * from nope" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('relation "nope" does not exist');
  });

  test("400 on malformed JSON or an empty statement", async () => {
    expect((await POST(postReq("{nope"))).status).toBe(400);
    expect((await POST(postReq({ sql: "   " }))).status).toBe(400);
    expect(h.runConsoleQuery).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/sql", () => {
  test("returns the run history for the group", async () => {
    h.listHistory.mockResolvedValue([{ id: "h1", sql: "select 1" }]);
    const res = await GET(
      new Request("http://x/api/console/sql", {
        headers: { "x-amzn-oidc-data": marketingToken },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ history: [{ id: "h1", sql: "select 1" }] });
  });
});
