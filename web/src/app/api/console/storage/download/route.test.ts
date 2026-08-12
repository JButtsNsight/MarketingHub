// @vitest-environment node
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
  signObject: vi.fn(),
}));

vi.mock("@/lib/console/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/storage")>();
  return {
    ...actual, // isSafePath + CAMPAIGN_BUCKET stay real
    bucketExists: h.bucketExists,
    signObject: h.signObject,
  };
});

import { GET } from "./route";

let platformToken: string;
let marketingToken: string;
let adminToken: string;

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
});

let albFetch: ReturnType<typeof installAlbKeyFetch>;

beforeEach(() => {
  setAlbEnv();
  albFetch = installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.bucketExists.mockResolvedValue(true);
  h.signObject.mockResolvedValue("http://internal.invalid/signed");
});

afterEach(() => {
  clearAlbEnv();
  vi.unstubAllGlobals();
});

/**
 * Serve the signed-URL fetch as an object with the chosen content-type, while
 * still delegating the ALB public-key fetch (requireUser) to the real key
 * mock — otherwise auth 401s.
 */
function stubUpstream(contentType: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("internal.invalid")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": contentType },
          }),
        );
      }
      return (albFetch as unknown as typeof fetch)(url, init);
    }),
  );
}

function req(path: string, extra = "") {
  return new Request(
    `http://x/api/console/storage/download?path=${encodeURIComponent(path)}${extra}`,
    { headers: { "x-amzn-oidc-data": platformToken } },
  );
}

describe("GET /api/console/storage/download — content-type safety", () => {
  test("403 for base marketing without the section; admins pass", async () => {
    stubUpstream("image/png");
    const forbidden = await GET(
      new Request("http://x/api/console/storage/download?path=logo.png", {
        headers: { "x-amzn-oidc-data": marketingToken },
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(h.signObject).not.toHaveBeenCalled();

    const admin = await GET(
      new Request("http://x/api/console/storage/download?path=logo.png", {
        headers: { "x-amzn-oidc-data": adminToken },
      }),
    );
    expect(admin.status).toBe(200);
  });

  test("an inline-requested SVG is forced to attachment with nosniff + CSP", async () => {
    stubUpstream("image/svg+xml");
    const res = await GET(req("evil.svg", "&inline=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("an inline-requested HTML file is forced to attachment", async () => {
    stubUpstream("text/html");
    const res = await GET(req("page.html", "&inline=1"));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("an allowlisted raster image is served inline", async () => {
    stubUpstream("image/png");
    const res = await GET(req("logo.png", "&inline=1"));
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("without ?inline it always downloads, even for a png", async () => {
    stubUpstream("image/png");
    const res = await GET(req("logo.png"));
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  test("401 unauthenticated; 400 on an unsafe path; 404 on an unknown bucket", async () => {
    const unauth = await GET(
      new Request("http://x/api/console/storage/download?path=a.png"),
    );
    expect(unauth.status).toBe(401);

    expect((await GET(req("../etc/passwd"))).status).toBe(400);

    h.bucketExists.mockResolvedValue(false);
    expect((await GET(req("a.png", "&bucket=nope"))).status).toBe(404);
  });
});
