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
  createBucket: vi.fn(),
  updateBucket: vi.fn(),
  deleteBucket: vi.fn(),
  emptyBucket: vi.fn(),
}));

vi.mock("@/lib/console/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/console/storage")>();
  return {
    ...actual,
    listBuckets: h.listBuckets,
    bucketExists: h.bucketExists,
    createBucket: h.createBucket,
    updateBucket: h.updateBucket,
    deleteBucket: h.deleteBucket,
    emptyBucket: h.emptyBucket,
  };
});

import { DELETE, GET, PATCH, POST } from "./route";

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
  h.listBuckets.mockResolvedValue([
    {
      id: "a",
      name: "campaign-templates",
      public: false,
      createdAt: null,
      fileSizeLimit: null,
      allowedMimeTypes: null,
    },
  ]);
});

afterEach(() => {
  clearAlbEnv();
});

function auth(): HeadersInit {
  return { "x-amzn-oidc-data": marketingToken };
}

function jsonReq(method: string, body: unknown): Request {
  return new Request("http://x/api/console/storage/buckets", {
    method,
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/console/storage/buckets", () => {
  test("401 unauthenticated; lists buckets with settings when authed", async () => {
    expect(
      (await GET(new Request("http://x/api/console/storage/buckets"))).status,
    ).toBe(401);

    const res = await GET(
      new Request("http://x/api/console/storage/buckets", { headers: auth() }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]).toMatchObject({
      name: "campaign-templates",
      fileSizeLimit: null,
      allowedMimeTypes: null,
    });
  });

  test("a listing failure surfaces as 400 with the real message", async () => {
    h.listBuckets.mockRejectedValue(
      new Error("[console:storage] list-buckets failed: upstream down"),
    );
    const res = await GET(
      new Request("http://x/api/console/storage/buckets", { headers: auth() }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("upstream down");
  });
});

describe("POST /api/console/storage/buckets (create)", () => {
  test("401 unauthenticated", async () => {
    const res = await POST(
      new Request("http://x/api/console/storage/buckets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "assets" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(h.createBucket).not.toHaveBeenCalled();
  });

  test("creates (private by default) and 201s", async () => {
    h.createBucket.mockResolvedValue(undefined);
    const res = await POST(jsonReq("POST", { name: "assets" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: "assets" });
    expect(h.createBucket).toHaveBeenCalledWith("assets", {
      public: undefined,
      fileSizeLimit: undefined,
      allowedMimeTypes: undefined,
    });
  });

  test("passes public + settings through", async () => {
    h.createBucket.mockResolvedValue(undefined);
    const res = await POST(
      jsonReq("POST", {
        name: "assets",
        public: true,
        fileSizeLimit: 1024,
        allowedMimeTypes: ["image/png", "image/*"],
      }),
    );
    expect(res.status).toBe(201);
    expect(h.createBucket).toHaveBeenCalledWith("assets", {
      public: true,
      fileSizeLimit: 1024,
      allowedMimeTypes: ["image/png", "image/*"],
    });
  });

  test("400 on bad shape (missing name, wrong types) and invalid JSON", async () => {
    expect((await POST(jsonReq("POST", {}))).status).toBe(400);
    expect(
      (await POST(jsonReq("POST", { name: "assets", fileSizeLimit: "big" })))
        .status,
    ).toBe(400);
    const raw = await POST(
      new Request("http://x/api/console/storage/buckets", {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: "{nope",
      }),
    );
    expect(raw.status).toBe(400);
    expect(h.createBucket).not.toHaveBeenCalled();
  });

  test("lib semantic rejections surface as 400 with the real message", async () => {
    h.createBucket.mockRejectedValue(
      new Error('[console:storage] create-bucket failed: invalid bucket name "Bad Name"'),
    );
    const res = await POST(jsonReq("POST", { name: "Bad Name" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "invalid bucket name",
    );
  });
});

describe("PATCH /api/console/storage/buckets (update)", () => {
  test("updates settings — public is always explicit", async () => {
    h.updateBucket.mockResolvedValue(undefined);
    const res = await PATCH(
      jsonReq("PATCH", {
        name: "assets",
        public: true,
        fileSizeLimit: null,
        allowedMimeTypes: ["image/*"],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: "assets" });
    expect(h.updateBucket).toHaveBeenCalledWith("assets", {
      public: true,
      fileSizeLimit: null,
      allowedMimeTypes: ["image/*"],
    });
  });

  test("400 when public is omitted; 404 unknown bucket", async () => {
    expect(
      (await PATCH(jsonReq("PATCH", { name: "campaign-templates" }))).status,
    ).toBe(400);

    h.bucketExists.mockResolvedValue(false);
    const res = await PATCH(jsonReq("PATCH", { name: "nope", public: false }));
    expect(res.status).toBe(404);
    expect(h.updateBucket).not.toHaveBeenCalled();
  });
});

describe("campaign-templates invariant (§7: never public, never wiped)", () => {
  test("403 on PATCH public=true — updateBucket never runs", async () => {
    const res = await PATCH(
      jsonReq("PATCH", { name: "campaign-templates", public: true }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      "must stay private",
    );
    expect(h.updateBucket).not.toHaveBeenCalled();
  });

  test("PATCH public=false still edits the other settings", async () => {
    h.updateBucket.mockResolvedValue(undefined);
    const res = await PATCH(
      jsonReq("PATCH", {
        name: "campaign-templates",
        public: false,
        fileSizeLimit: 1024,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.updateBucket).toHaveBeenCalledWith("campaign-templates", {
      public: false,
      fileSizeLimit: 1024,
      allowedMimeTypes: undefined,
    });
  });

  test("403 on POST public=true recreation", async () => {
    const res = await POST(
      jsonReq("POST", { name: "campaign-templates", public: true }),
    );
    expect(res.status).toBe(403);
    expect(h.createBucket).not.toHaveBeenCalled();
  });

  test.each([["delete", undefined], ["empty", "empty"]])(
    "403 on DELETE (%s) even with a matching confirm",
    async (_label, action) => {
      const res = await DELETE(
        jsonReq("DELETE", {
          name: "campaign-templates",
          ...(action ? { action } : {}),
          confirm: "campaign-templates",
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain(
        "cannot be emptied or deleted",
      );
      expect(h.deleteBucket).not.toHaveBeenCalled();
      expect(h.emptyBucket).not.toHaveBeenCalled();
    },
  );
});

describe("DELETE /api/console/storage/buckets (delete/empty)", () => {
  test("deletes only with a matching confirm echo", async () => {
    h.deleteBucket.mockResolvedValue(undefined);
    const res = await DELETE(
      jsonReq("DELETE", { name: "assets", confirm: "assets" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "assets" });
    expect(h.deleteBucket).toHaveBeenCalledWith("assets");
    expect(h.emptyBucket).not.toHaveBeenCalled();
  });

  test("400 when confirm is missing or mismatched — nothing destructive runs", async () => {
    expect((await DELETE(jsonReq("DELETE", { name: "assets" }))).status).toBe(400);

    const mismatch = await DELETE(
      jsonReq("DELETE", { name: "assets", confirm: "asset" }),
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toContain(
      "confirm",
    );
    expect(h.deleteBucket).not.toHaveBeenCalled();
    expect(h.emptyBucket).not.toHaveBeenCalled();
    expect(h.bucketExists).not.toHaveBeenCalled();
  });

  test("action=empty empties instead of deleting", async () => {
    h.emptyBucket.mockResolvedValue(undefined);
    const res = await DELETE(
      jsonReq("DELETE", { name: "assets", action: "empty", confirm: "assets" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emptied: "assets" });
    expect(h.emptyBucket).toHaveBeenCalledWith("assets");
    expect(h.deleteBucket).not.toHaveBeenCalled();
  });

  test("404 unknown bucket; 400 unknown action", async () => {
    h.bucketExists.mockResolvedValue(false);
    expect(
      (await DELETE(jsonReq("DELETE", { name: "nope", confirm: "nope" }))).status,
    ).toBe(404);

    h.bucketExists.mockResolvedValue(true);
    expect(
      (
        await DELETE(
          jsonReq("DELETE", { name: "assets", action: "nuke", confirm: "assets" }),
        )
      ).status,
    ).toBe(400);
    expect(h.deleteBucket).not.toHaveBeenCalled();
  });

  test("upstream refusal (bucket not empty) surfaces as 400 with the real message", async () => {
    h.deleteBucket.mockRejectedValue(
      new Error(
        "[console:storage] delete-bucket failed: The bucket you tried to delete is not empty",
      ),
    );
    const res = await DELETE(
      jsonReq("DELETE", { name: "assets", confirm: "assets" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not empty");
  });
});
