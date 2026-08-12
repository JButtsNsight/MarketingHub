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
  albPublicPem,
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

// Registry lookup mock: the route asks the service client whether `name` is a
// registered edge function. We capture the chain args to assert the allowlist
// really is registry-driven.
const h = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  chainCalls: [] as Array<{ schema: string; table: string; column: string; value: string }>,
}));

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({
    schema: (schema: string) => ({
      from: (table: string) => ({
        select: () => ({
          eq: (column: string, value: string) => {
            h.chainCalls.push({ schema, table, column, value });
            return { maybeSingle: h.maybeSingle };
          },
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;
let viewersToken: string;

/** Upstream (Kong /functions/v1/*) mock, dispatched off the shared fetch stub. */
type EdgeFetch = (url: unknown, init?: RequestInit) => Promise<Response>;
let edgeFetch: ReturnType<typeof vi.fn<EdgeFetch>>;

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
  process.env.SUPABASE_URL = "http://kong.test:8000";

  h.maybeSingle.mockReset().mockResolvedValue({ data: { name: "hello" }, error: null });
  h.chainCalls.length = 0;

  // One global fetch stub, two upstreams: the ALB public-key endpoint (auth)
  // and Kong's /functions/v1/* (the unit under test).
  edgeFetch = vi.fn(async () => new Response('{"message":"Hello!"}', {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  installAlbKeyFetch().mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/functions/v1/")) return edgeFetch(url, init);
    return new Response(albPublicPem(), { status: 200 });
  });
});

afterEach(() => {
  clearAlbEnv();
  delete process.env.SUPABASE_URL;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sectionHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "x-amzn-oidc-data": platformToken,
    "content-type": "application/json",
    ...extra,
  };
}

function postReq(body: unknown, headers: HeadersInit = sectionHeaders()) {
  return new Request("http://x/api/console/functions/invoke", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/console/functions/invoke — gate", () => {
  test("401/403 before the registry or Kong is touched", async () => {
    expect((await POST(postReq({ name: "hello" }, {}))).status).toBe(401);
    expect(
      (
        await POST(
          postReq(
            { name: "hello" },
            {
              "x-amzn-oidc-data": viewersToken,
              "content-type": "application/json",
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(h.maybeSingle).not.toHaveBeenCalled();
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await POST(
      postReq(
        { name: "hello" },
        {
          "x-amzn-oidc-data": marketingToken,
          "content-type": "application/json",
        },
      ),
    );
    expect(forbidden.status).toBe(403);
    expect(edgeFetch).not.toHaveBeenCalled();

    const admin = await POST(
      postReq(
        { name: "hello" },
        {
          "x-amzn-oidc-data": adminToken,
          "content-type": "application/json",
        },
      ),
    );
    expect(admin.status).toBe(200);
  });
});

describe("POST /api/console/functions/invoke — validation", () => {
  test("400 on malformed JSON", async () => {
    expect((await POST(postReq("{nope"))).status).toBe(400);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test.each([
    ["uppercase", "Hello"],
    ["path traversal", "../main"],
    ["slash", "a/b"],
    ["space", "hello world"],
    ["too long", "a".repeat(65)],
    ["empty", ""],
  ])("400 on a bad name (%s) — never reaches the registry", async (_label, name) => {
    const res = await POST(postReq({ name }));
    expect(res.status).toBe(400);
    expect(h.maybeSingle).not.toHaveBeenCalled();
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("400 on unknown keys (strict schema)", async () => {
    const res = await POST(postReq({ name: "hello", headers: { cookie: "x" } }));
    expect(res.status).toBe(400);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("400 when a GET carries a body", async () => {
    const res = await POST(postReq({ name: "hello", method: "GET", body: "{}" }));
    expect(res.status).toBe(400);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("400 when the request body exceeds the 32KB cap", async () => {
    const res = await POST(
      postReq({ name: "hello", body: "x".repeat(32 * 1024 + 1) }),
    );
    expect(res.status).toBe(400);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("413 when the ENVELOPE exceeds 256KB — bounded before parsing, junk keys included", async () => {
    // A giant unknown key used to be fully buffered by req.json() before the
    // strict schema rejected it (OOM lever); the bounded reader refuses it.
    const res = await POST(
      postReq({ name: "hello", junk: "x".repeat(256 * 1024 + 1) }),
    );
    expect(res.status).toBe(413);
    expect(h.maybeSingle).not.toHaveBeenCalled();
    expect(edgeFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/functions/invoke — registry allowlist", () => {
  test("404 when the name is not in the registry; Kong never called", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(postReq({ name: "not-deployed" }));
    expect(res.status).toBe(404);
    expect(edgeFetch).not.toHaveBeenCalled();
    // Allowlist source of truth: marketinghub.edge_functions by name.
    expect(h.chainCalls).toEqual([
      {
        schema: "marketinghub",
        table: "edge_functions",
        column: "name",
        value: "not-deployed",
      },
    ]);
  });

  test("503 {reason} when the registry is unreadable (migration not applied)", async () => {
    h.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'relation "marketinghub.edge_functions" does not exist' },
    });
    const res = await POST(postReq({ name: "hello" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toMatch(/registry unavailable/i);
    expect(edgeFetch).not.toHaveBeenCalled();
  });

  test("503 {reason} when SUPABASE_URL is unset (before any registry read)", async () => {
    delete process.env.SUPABASE_URL;
    const res = await POST(postReq({ name: "hello" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/SUPABASE_URL/);
    expect(edgeFetch).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/functions/invoke — proxying", () => {
  test("invokes ${SUPABASE_URL}/functions/v1/<name> and returns the bounded result shape", async () => {
    const res = await POST(postReq({ name: "hello", body: '{"n":"w"}' }));
    expect(res.status).toBe(200);

    const [url, init] = edgeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kong.test:8000/functions/v1/hello");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"n":"w"}');
    expect(init.redirect).toBe("manual");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(200);
    expect(typeof body.durationMs).toBe("number");
    expect(body.contentType).toBe("application/json");
    expect(body.body).toBe('{"message":"Hello!"}');
    expect(body.truncated).toBe(false);
  });

  test("NEVER forwards client cookies / auth / ALB identity headers", async () => {
    await POST(
      postReq(
        { name: "hello", body: "{}" },
        sectionHeaders({
          cookie: "session=super-secret",
          authorization: "Bearer client-token",
        }),
      ),
    );
    const [, init] = edgeFetch.mock.calls[0] as [string, RequestInit];
    // The upstream headers are built from scratch: content-type only.
    expect(init.headers).toEqual({ "content-type": "application/json" });
    const flat = JSON.stringify(init.headers).toLowerCase();
    expect(flat).not.toContain("cookie");
    expect(flat).not.toContain("authorization");
    expect(flat).not.toContain("oidc");
  });

  test("GET invocations send no body and no content-type", async () => {
    const res = await POST(postReq({ name: "hello", method: "GET" }));
    expect(res.status).toBe(200);
    const [, init] = edgeFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });

  test("non-2xx upstream statuses are reported, not treated as proxy errors", async () => {
    // main/index.ts answers 500 {msg} when the function dir doesn't exist.
    edgeFetch.mockResolvedValue(
      new Response('{"msg":"boot failure"}', { status: 500 }),
    );
    const res = await POST(postReq({ name: "hello", body: "{}" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: number }).status).toBe(500);
  });

  test("truncates the upstream body at 64KB and flags it", async () => {
    edgeFetch.mockResolvedValue(new Response("y".repeat(64 * 1024 + 500), { status: 200 }));
    const res = await POST(postReq({ name: "hello", body: "{}" }));
    const body = (await res.json()) as { body: string; truncated: boolean };
    expect(body.body.length).toBe(64 * 1024);
    expect(body.truncated).toBe(true);
  });
});

describe("POST /api/console/functions/invoke — failure mapping", () => {
  test("network failure (edge runtime down) maps to 502 {reason}", async () => {
    edgeFetch.mockRejectedValue(new TypeError("fetch failed"));
    const res = await POST(postReq({ name: "hello", body: "{}" }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toMatch(/unreachable/i);
  });

  test("an aborted upstream maps to 502 with a timed-out reason", async () => {
    edgeFetch.mockRejectedValue(
      new DOMException("This operation was aborted", "AbortError"),
    );
    const res = await POST(postReq({ name: "hello", body: "{}" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/timed out/i);
  });

  test("the 20s AbortController deadline itself fires the abort (fake timers)", async () => {
    vi.useFakeTimers();
    // An upstream that never answers: settle only when the route aborts it.
    edgeFetch.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(
              (init.signal as AbortSignal).reason ??
                new DOMException("aborted", "AbortError"),
            ),
          );
        }),
    );

    const pending = POST(postReq({ name: "hello", body: "{}" }));
    // Let auth + registry (real async) finish so the 20s timer exists…
    await vi.waitFor(() => expect(edgeFetch).toHaveBeenCalled());
    // …then jump past the deadline.
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await pending;

    expect(res.status).toBe(502);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toMatch(/20s.*timed out|timed out/i);
  });
});
