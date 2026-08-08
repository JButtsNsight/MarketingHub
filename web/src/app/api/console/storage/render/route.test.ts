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
  bucketExists: vi.fn(),
  fetchTransformedImage: vi.fn(),
}));

vi.mock("@/lib/console/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/storage")>();
  return {
    // isSafePath, isSafeBucketName, normalizeTransform and the REAL
    // TransformUnavailableError class stay live — the guard + clamping under
    // test run against them.
    ...actual,
    bucketExists: h.bucketExists,
    fetchTransformedImage: h.fetchTransformedImage,
  };
});

import { TransformUnavailableError } from "@/lib/console/storage";
import { GET } from "./route";

let marketingToken: string;

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
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.bucketExists.mockResolvedValue(true);
});

afterEach(() => {
  clearAlbEnv();
});

function auth(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function renderReq(query: string, headers: HeadersInit = auth()): Request {
  return new Request(`http://x/api/console/storage/render?${query}`, {
    headers,
  });
}

/** Upstream TransformedImage stub with a real readable stream. */
function transformed(contentType: string, body = "img-bytes") {
  return {
    stream: new Blob([body]).stream(),
    contentType,
    size: body.length,
  };
}

describe("GET /api/console/storage/render — gate + input validation", () => {
  test("401 unauthenticated", async () => {
    const res = await GET(renderReq("bucket=b1&path=a.png", {}));
    expect(res.status).toBe(401);
    expect(h.fetchTransformedImage).not.toHaveBeenCalled();
  });

  test("400 traversal path, 400 bad bucket name, 404 unknown bucket", async () => {
    expect((await GET(renderReq("bucket=b1&path=..%2Fetc"))).status).toBe(400);
    expect((await GET(renderReq("bucket=..&path=a.png"))).status).toBe(400);

    h.bucketExists.mockResolvedValue(false);
    expect((await GET(renderReq("bucket=nope&path=a.png"))).status).toBe(404);
    expect(h.fetchTransformedImage).not.toHaveBeenCalled();
  });

  test("400 on non-numeric width, bad resize, bad format — before upstream", async () => {
    for (const query of [
      "bucket=b1&path=a.png&width=abc",
      "bucket=b1&path=a.png&resize=stretch",
      "bucket=b1&path=a.png&format=webp",
    ]) {
      const res = await GET(renderReq(query));
      expect(res.status).toBe(400);
    }
    expect(h.fetchTransformedImage).not.toHaveBeenCalled();
  });
});

describe("GET /api/console/storage/render — param clamping", () => {
  test("dimensions clamp to 1..2000, quality to 20..100, floats floor", async () => {
    h.fetchTransformedImage.mockResolvedValue(transformed("image/png"));
    const res = await GET(
      renderReq(
        "bucket=b1&path=a.png&width=99999&height=0&quality=5&resize=contain&format=avif",
      ),
    );
    expect(res.status).toBe(200);
    expect(h.fetchTransformedImage).toHaveBeenCalledWith(
      "b1",
      "a.png",
      { width: 2000, height: 1, quality: 20, resize: "contain", format: "avif" },
      undefined, // renderReq sets no Accept header

    );

    h.fetchTransformedImage.mockClear();
    h.fetchTransformedImage.mockResolvedValue(transformed("image/png"));
    await GET(renderReq("bucket=b1&path=a.png&width=150.9&quality=999"));
    expect(h.fetchTransformedImage).toHaveBeenCalledWith(
      "b1",
      "a.png",
      { width: 150, quality: 100 },
      undefined,
    );
  });

  test("empty params are absent; Accept header forwards for WebP negotiation", async () => {
    h.fetchTransformedImage.mockResolvedValue(transformed("image/png"));
    const res = await GET(
      renderReq("bucket=b1&path=a.png&width=&quality=", {
        ...auth(),
        accept: "image/webp,image/*",
      }),
    );
    expect(res.status).toBe(200);
    expect(h.fetchTransformedImage).toHaveBeenCalledWith(
      "b1",
      "a.png",
      {},
      "image/webp,image/*",
    );
  });
});

describe("GET /api/console/storage/render — inline allowlist guard", () => {
  test.each([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
  ])("raster type %s serves inline", async (contentType) => {
    h.fetchTransformedImage.mockResolvedValue(transformed(contentType));
    const res = await GET(renderReq("bucket=b1&path=dir/pic.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(contentType);
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="pic.bin"',
    );
  });

  test.each([
    "image/svg+xml",
    "image/svg+xml; charset=utf-8",
    "text/html",
    "application/xml",
    "application/octet-stream",
    "text/plain",
  ])("non-raster type %s is forced attachment", async (contentType) => {
    h.fetchTransformedImage.mockResolvedValue(transformed(contentType));
    const res = await GET(renderReq("bucket=b1&path=dir/pic.bin"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="pic.bin"',
    );
  });

  test("parameterized raster type stays inline (essence match)", async () => {
    h.fetchTransformedImage.mockResolvedValue(
      transformed("image/png; charset=binary"),
    );
    const res = await GET(renderReq("bucket=b1&path=a.png"));
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="a.png"',
    );
  });

  test("hardening headers are always set and the body streams through", async () => {
    h.fetchTransformedImage.mockResolvedValue(
      transformed("image/svg+xml", "<svg/>"),
    );
    const res = await GET(renderReq("bucket=b1&path=a.svg"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("<svg/>");
  });
});

describe("GET /api/console/storage/render — upstream error mapping", () => {
  test("TransformUnavailableError → 503 with a clear JSON error", async () => {
    h.fetchTransformedImage.mockRejectedValue(
      new TransformUnavailableError("upstream 502"),
    );
    const res = await GET(renderReq("bucket=b1&path=a.png"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Image transformations are unavailable",
    });
  });

  test("missing object → 404; other prefixed failures → 400 with message", async () => {
    h.fetchTransformedImage.mockRejectedValue(
      new Error("[console:storage] render failed: object not found"),
    );
    const missing = await GET(renderReq("bucket=b1&path=a.png"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "object not found" });

    h.fetchTransformedImage.mockRejectedValue(
      new Error("[console:storage] render failed: upstream 422: bad image"),
    );
    const bad = await GET(renderReq("bucket=b1&path=a.png"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "upstream 422: bad image" });
  });
});
