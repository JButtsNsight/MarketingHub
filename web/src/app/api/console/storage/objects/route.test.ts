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
  listBuckets: vi.fn(),
  bucketExists: vi.fn(),
  listBucket: vi.fn(),
  uploadObject: vi.fn(),
  deleteObjects: vi.fn(),
  moveObject: vi.fn(),
}));

vi.mock("@/lib/console/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/storage")>();
  return {
    ...actual, // isSafePath + UPLOAD_MAX_BYTES stay REAL — they're under test
    listBuckets: h.listBuckets,
    bucketExists: h.bucketExists,
    listBucket: h.listBucket,
    uploadObject: h.uploadObject,
    deleteObjects: h.deleteObjects,
    moveObject: h.moveObject,
  };
});

import { DELETE, GET, PATCH, POST } from "./route";

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

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.bucketExists.mockResolvedValue(true);
  h.listBuckets.mockResolvedValue([
    { id: "a", name: "campaign-templates", public: false, createdAt: null },
  ]);
});

afterEach(() => {
  clearAlbEnv();
});

function auth(): HeadersInit {
  return { "x-amzn-oidc-data": platformToken };
}

describe("GET /api/console/storage/objects", () => {
  test("401 unauthenticated; lists buckets + entries when authed", async () => {
    expect(
      (await GET(new Request("http://x/api/console/storage/objects"))).status,
    ).toBe(401);

    h.listBucket.mockResolvedValue([
      { name: "file.png", isFolder: false, size: 10, mimetype: "image/png", updatedAt: null, path: "file.png" },
    ]);
    const res = await GET(
      new Request(
        "http://x/api/console/storage/objects?bucket=campaign-templates",
        { headers: auth() },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets).toHaveLength(1);
    expect(body.entries).toHaveLength(1);
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await GET(
      new Request(
        "http://x/api/console/storage/objects?bucket=campaign-templates",
        { headers: { "x-amzn-oidc-data": marketingToken } },
      ),
    );
    expect(forbidden.status).toBe(403);
    expect(h.listBucket).not.toHaveBeenCalled();

    h.listBucket.mockResolvedValue([]);
    const admin = await GET(
      new Request(
        "http://x/api/console/storage/objects?bucket=campaign-templates",
        { headers: { "x-amzn-oidc-data": adminToken } },
      ),
    );
    expect(admin.status).toBe(200);
  });

  test("404 unknown bucket; 400 unsafe prefix", async () => {
    const res = await GET(
      new Request("http://x/api/console/storage/objects?bucket=nope", {
        headers: auth(),
      }),
    );
    expect(res.status).toBe(404);

    const res2 = await GET(
      new Request(
        "http://x/api/console/storage/objects?bucket=campaign-templates&prefix=..%2Fetc",
        { headers: auth() },
      ),
    );
    expect(res2.status).toBe(400);
    expect(h.listBucket).not.toHaveBeenCalled();
  });
});

describe("POST /api/console/storage/objects (upload)", () => {
  function uploadReq(name: string, size = 10, bucket = "campaign-templates") {
    const form = new FormData();
    form.set("bucket", bucket);
    form.set("prefix", "folder");
    form.set("file", new File([new Uint8Array(size)], name, { type: "image/png" }));
    return new Request("http://x/api/console/storage/objects", {
      method: "POST",
      headers: auth(),
      body: form,
    });
  }

  test("uploads under the prefix and 201s", async () => {
    h.uploadObject.mockResolvedValue(undefined);
    const res = await POST(uploadReq("pic.png"));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ uploaded: "folder/pic.png" });
    expect(h.uploadObject).toHaveBeenCalledWith(
      "campaign-templates",
      "folder/pic.png",
      expect.any(ArrayBuffer),
      "image/png",
    );
  });

  test("413 on empty/oversized files; 400 on unsafe filenames; 404 unknown bucket", async () => {
    expect((await POST(uploadReq("pic.png", 0))).status).toBe(413);
    expect((await POST(uploadReq("../evil.png"))).status).toBe(400);

    h.bucketExists.mockResolvedValue(false);
    expect((await POST(uploadReq("pic.png", 10, "nope"))).status).toBe(404);
    expect(h.uploadObject).not.toHaveBeenCalled();
  });

  test("a Storage conflict (no-overwrite) surfaces as 400 with the real message", async () => {
    h.uploadObject.mockRejectedValue(
      new Error("[console:storage] upload failed: The resource already exists"),
    );
    const res = await POST(uploadReq("pic.png"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "already exists",
    );
  });
});

describe("PATCH + DELETE /api/console/storage/objects", () => {
  test("PATCH moves after validating both paths", async () => {
    h.moveObject.mockResolvedValue(undefined);
    const res = await PATCH(
      new Request("http://x/api/console/storage/objects", {
        method: "PATCH",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
          bucket: "campaign-templates",
          from: "a/old.png",
          to: "a/new.png",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(h.moveObject).toHaveBeenCalledWith(
      "campaign-templates",
      "a/old.png",
      "a/new.png",
    );

    const bad = await PATCH(
      new Request("http://x/api/console/storage/objects", {
        method: "PATCH",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
          bucket: "campaign-templates",
          from: "a/old.png",
          to: "../escape.png",
        }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  test("DELETE removes validated paths and reports the count", async () => {
    h.deleteObjects.mockResolvedValue(2);
    const res = await DELETE(
      new Request("http://x/api/console/storage/objects", {
        method: "DELETE",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
          bucket: "campaign-templates",
          paths: ["a/x.png", "a/y.png"],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    const bad = await DELETE(
      new Request("http://x/api/console/storage/objects", {
        method: "DELETE",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
          bucket: "campaign-templates",
          paths: ["../evil"],
        }),
      }),
    );
    expect(bad.status).toBe(400);
  });
});
