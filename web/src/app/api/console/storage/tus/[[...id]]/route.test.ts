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
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";
import { TUS_MAX_BYTES } from "@/lib/console/storage";

import { DELETE, HEAD, OPTIONS, PATCH, POST } from "./route";

const UPSTREAM_BASE = "http://kong.internal:8000";
const SERVICE_KEY = "test-service-role-key";

let marketingToken: string;

type UpstreamHandler = (
  url: string,
  init: RequestInit & { duplex?: string },
) => Response | Promise<Response>;

/** Records calls the route makes to the storage upstream (never the ALB key endpoint). */
let upstream: ReturnType<typeof vi.fn<UpstreamHandler>>;

/**
 * Stub global fetch: serve the ALB public key for the auth path, hand every
 * other request to the per-test upstream handler.
 */
function installFetch(
  handler: UpstreamHandler = async () => new Response(null, { status: 204 }),
): void {
  upstream = vi.fn<UpstreamHandler>(handler);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("public-keys.auth.elb")) {
        return new Response(albPublicPem(), { status: 200 });
      }
      return upstream(url, init ?? {});
    }),
  );
}

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing"],
  });
});

beforeEach(() => {
  setAlbEnv();
  process.env.SUPABASE_URL = UPSTREAM_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  installFetch();
});

afterEach(() => {
  clearAlbEnv();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
});

function auth(extra: Record<string, string> = {}): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken, ...extra };
}

function ctx(id?: string[]) {
  return { params: Promise.resolve(id === undefined ? {} : { id }) };
}

function createReq(headers: HeadersInit): Request {
  return new Request("http://x/api/console/storage/tus", {
    method: "POST",
    headers,
  });
}

describe("auth gate", () => {
  test("401 unauthenticated on every method; upstream never touched", async () => {
    const bare = new Request("http://x/api/console/storage/tus");
    expect((await POST(createReq({}), ctx())).status).toBe(401);
    expect(
      (
        await PATCH(
          new Request("http://x/api/console/storage/tus/abc", { method: "PATCH" }),
          ctx(["abc"]),
        )
      ).status,
    ).toBe(401);
    expect((await OPTIONS(bare, ctx())).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("POST create (URL construction + header filtering + location rewrite)", () => {
  test("forwards ONLY allowlisted headers, injects the service key, rewrites location", async () => {
    installFetch(
      async () =>
        new Response(null, {
          status: 201,
          headers: {
            location: `${UPSTREAM_BASE}/storage/v1/upload/resumable/abc123`,
            "tus-resumable": "1.0.0",
            "upload-expires": "Fri, 08 Aug 2026 12:00:00 GMT",
            // Internal-only headers that must never reach the browser.
            "set-cookie": "upstream=1",
            "x-internal-secret": "leak",
            "content-type": "text/plain",
          },
        }),
    );

    const res = await POST(
      createReq(
        auth({
          "tus-resumable": "1.0.0",
          "upload-length": "1000",
          "upload-metadata": "bucketName Y2FtcGFpZ24=,objectName Zm9v",
          "content-type": "application/offset+octet-stream",
          // Client credentials that must never cross to the upstream.
          authorization: "Bearer client-token",
          apikey: "client-apikey",
          cookie: "session=evil",
          "x-custom": "nope",
        }),
      ),
      ctx(),
    );

    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/api/console/storage/tus/abc123");
    expect(res.headers.get("tus-resumable")).toBe("1.0.0");
    expect(res.headers.get("upload-expires")).toBe("Fri, 08 Aug 2026 12:00:00 GMT");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal-secret")).toBeNull();
    expect(res.headers.get("content-type")).toBeNull();

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM_BASE}/storage/v1/upload/resumable`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${SERVICE_KEY}`);
    expect(sent.get("apikey")).toBe(SERVICE_KEY);
    expect(sent.get("tus-resumable")).toBe("1.0.0");
    expect(sent.get("upload-length")).toBe("1000");
    expect(sent.get("upload-metadata")).toBe("bucketName Y2FtcGFpZ24=,objectName Zm9v");
    expect(sent.get("content-type")).toBe("application/offset+octet-stream");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-custom")).toBeNull();
    expect(sent.get("x-amzn-oidc-data")).toBeNull();
  });

  test("trailing slash on SUPABASE_URL never doubles up", async () => {
    process.env.SUPABASE_URL = `${UPSTREAM_BASE}/`;
    installFetch(async () => new Response(null, { status: 201 }));
    await POST(createReq(auth({ "upload-length": "1" })), ctx());
    expect(upstream.mock.calls[0][0]).toBe(
      `${UPSTREAM_BASE}/storage/v1/upload/resumable`,
    );
  });

  test("rewrites path-only locations and re-encodes the id", async () => {
    installFetch(
      async () =>
        new Response(null, {
          status: 201,
          headers: { location: "/storage/v1/upload/resumable/xyz=" },
        }),
    );
    const res = await POST(createReq(auth({ "upload-length": "1" })), ctx());
    expect(res.headers.get("location")).toBe("/api/console/storage/tus/xyz%3D");
  });

  test("502 when the upstream location's id is not a safe token", async () => {
    installFetch(
      async () =>
        new Response(null, {
          status: 201,
          headers: {
            location: `${UPSTREAM_BASE}/storage/v1/upload/resumable/bad%20seg%2F..`,
          },
        }),
    );
    const res = await POST(createReq(auth({ "upload-length": "1" })), ctx());
    expect(res.status).toBe(502);
  });

  test("502 when the upstream is unreachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await POST(createReq(auth({ "upload-length": "1" })), ctx());
    expect(res.status).toBe(502);
  });
});

describe("Upload-Metadata validation at creation (console-manageable names only)", () => {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

  test.each([
    ["unsafe objectName (parens)", `objectName ${b64("trap(1).png")}`],
    ["objectName traversal", `objectName ${b64("../evil.png")}`],
    ["objectName trailing slash", `objectName ${b64("folder/")}`],
    ["unsafe bucketName", `bucketName ${b64("no spaces here?")}`],
    ["malformed base64 value", "objectName not*base64!"],
    ["duplicate key", `objectName ${b64("a.png")},objectName ${b64("b.png")}`],
  ])("400 on %s; upstream never called", async (_label, metadata) => {
    const res = await POST(
      createReq(auth({ "upload-length": "1", "upload-metadata": metadata })),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  test("safe names (with extra keys like contentType) pass through untouched", async () => {
    installFetch(async () => new Response(null, { status: 201 }));
    const metadata = [
      `bucketName ${b64("campaign-templates")}`,
      `objectName ${b64("brand/logo 2.png")}`,
      `contentType ${b64("image/png")}`,
      "cacheControl",
    ].join(",");
    const res = await POST(
      createReq(auth({ "upload-length": "1", "upload-metadata": metadata })),
      ctx(),
    );
    expect(res.status).toBe(201);
    const sent = new Headers((upstream.mock.calls[0] as [string, RequestInit])[1].headers);
    expect(sent.get("upload-metadata")).toBe(metadata);
  });

  test("chunk PATCHes never re-parse metadata (creation owned it)", async () => {
    installFetch(async () => new Response(null, { status: 204 }));
    const res = await PATCH(
      new Request("http://x/api/console/storage/tus/abc123", {
        method: "PATCH",
        headers: auth({
          "upload-offset": "0",
          "upload-metadata": "objectName not*base64!",
        }),
      }),
      ctx(["abc123"]),
    );
    expect(res.status).toBe(204);
  });
});

describe("size cap (Upload-Length at creation)", () => {
  test.each([
    ["absent", {}],
    ["non-numeric", { "upload-length": "abc" }],
    ["negative", { "upload-length": "-5" }],
    ["over the cap", { "upload-length": String(TUS_MAX_BYTES + 1) }],
  ])("413 when upload-length is %s; upstream never called", async (_label, headers) => {
    const res = await POST(createReq(auth(headers as Record<string, string>)), ctx());
    expect(res.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  test("exactly TUS_MAX_BYTES passes through", async () => {
    installFetch(async () => new Response(null, { status: 201 }));
    const res = await POST(
      createReq(auth({ "upload-length": String(TUS_MAX_BYTES) })),
      ctx(),
    );
    expect(res.status).toBe(201);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  test("PATCH chunks are not re-capped (length was enforced at create)", async () => {
    installFetch(async () => new Response(null, { status: 204 }));
    const res = await PATCH(
      new Request("http://x/api/console/storage/tus/abc123", {
        method: "PATCH",
        headers: auth({ "upload-offset": "0" }),
      }),
      ctx(["abc123"]),
    );
    expect(res.status).toBe(204);
  });
});

describe("PATCH (streamed chunk relay)", () => {
  test("streams the raw body upstream with duplex half and relays 204 + offset", async () => {
    let receivedBody: Uint8Array | null = null;
    installFetch(async (_url, init) => {
      receivedBody = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      return new Response(null, {
        status: 204,
        headers: { "tus-resumable": "1.0.0", "upload-offset": "512" },
      });
    });

    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await PATCH(
      new Request("http://x/api/console/storage/tus/abc123", {
        method: "PATCH",
        headers: auth({
          "tus-resumable": "1.0.0",
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        }),
        body: chunk,
      }),
      ctx(["abc123"]),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get("upload-offset")).toBe("512");
    expect(res.body).toBeNull();

    const [url, init] = upstream.mock.calls[0] as [
      string,
      RequestInit & { duplex?: string },
    ];
    expect(url).toBe(`${UPSTREAM_BASE}/storage/v1/upload/resumable/abc123`);
    expect(init.duplex).toBe("half");
    expect(Array.from(receivedBody!)).toEqual([1, 2, 3, 4, 5]);
  });

  test.each([
    ["traversal", [".."]],
    ["dot segment", ["."]],
    ["scheme separator", ["http:", "evil.example"]],
    ["space", ["bad seg"]],
    ["slash smuggled by decode", ["a/b"]],
  ])("400 on unsafe id (%s); upstream never called", async (_label, id) => {
    const res = await PATCH(
      new Request("http://x/api/console/storage/tus/x", {
        method: "PATCH",
        headers: auth({ "upload-offset": "0" }),
      }),
      ctx(id as string[]),
    );
    expect(res.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  test("400 when the id is missing on PATCH/HEAD/DELETE", async () => {
    for (const fn of [PATCH, HEAD, DELETE]) {
      const res = await fn(
        new Request("http://x/api/console/storage/tus", {
          method: fn === PATCH ? "PATCH" : fn === HEAD ? "HEAD" : "DELETE",
          headers: auth(),
        }),
        ctx(),
      );
      expect(res.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("HEAD / DELETE / OPTIONS relay", () => {
  test("HEAD relays offset headers with no body", async () => {
    installFetch(
      async () =>
        new Response(null, {
          status: 200,
          headers: {
            "tus-resumable": "1.0.0",
            "upload-offset": "1024",
            "upload-length": "4096",
            "cache-control": "no-store",
          },
        }),
    );
    const res = await HEAD(
      new Request("http://x/api/console/storage/tus/abc123", {
        method: "HEAD",
        headers: auth({ "tus-resumable": "1.0.0" }),
      }),
      ctx(["abc123"]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("upload-offset")).toBe("1024");
    expect(res.headers.get("upload-length")).toBe("4096");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toBeNull();
    expect(upstream.mock.calls[0][0]).toBe(
      `${UPSTREAM_BASE}/storage/v1/upload/resumable/abc123`,
    );
  });

  test("DELETE forwards to the upload URL and relays the status", async () => {
    installFetch(async () => new Response(null, { status: 204 }));
    const res = await DELETE(
      new Request("http://x/api/console/storage/tus/abc123", {
        method: "DELETE",
        headers: auth({ "tus-resumable": "1.0.0" }),
      }),
      ctx(["abc123"]),
    );
    expect(res.status).toBe(204);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM_BASE}/storage/v1/upload/resumable/abc123`);
    expect(init.method).toBe("DELETE");
  });

  test("OPTIONS relays capabilities and clamps tus-max-size to the proxy cap", async () => {
    installFetch(
      async () =>
        new Response(null, {
          status: 204,
          headers: {
            "tus-version": "1.0.0",
            "tus-extension": "creation,termination",
            "tus-max-size": String(50 * 1024 * 1024 * 1024),
          },
        }),
    );
    const res = await OPTIONS(
      new Request("http://x/api/console/storage/tus", {
        method: "OPTIONS",
        headers: auth(),
      }),
      ctx(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("tus-version")).toBe("1.0.0");
    expect(res.headers.get("tus-extension")).toBe("creation,termination");
    expect(res.headers.get("tus-max-size")).toBe(String(TUS_MAX_BYTES));
  });
});
