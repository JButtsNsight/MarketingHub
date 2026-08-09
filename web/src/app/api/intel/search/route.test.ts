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
  searchChunks: vi.fn(),
}));

const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
  getServiceClient: () => {
    throw new Error("routes must use the user client, not the service client");
  },
}));

// Partial mock: searchChunks stubbed; NotProvisionedError stays real. The
// provider error classes are imported from the REAL providers module so the
// route's instanceof mapping is what's under test.
vi.mock("@/lib/intel/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/repo")>();
  return { ...actual, searchChunks: h.searchChunks };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import {
  EmbeddingConfigError,
  EmbeddingProviderError,
} from "@/lib/intel/providers";
import { GET } from "./route";

const SOURCE_ID = "5f5e8c2a-9d1b-4f3a-8a51-51e6dd2e1a01";

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
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
  h.searchChunks.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function req(query: string, headers?: HeadersInit) {
  return new Request(`http://x/api/intel/search${query}`, {
    headers: headers ?? { "x-amzn-oidc-data": marketingToken },
  });
}

const searchResult = {
  provider: { model: "stub-djb2-1024", dims: 1024 },
  rows: [
    {
      chunk_id: 7,
      document_id: "d1",
      source_id: SOURCE_ID,
      seq: 0,
      content: "Acme charges $99.",
      similarity: 0.87,
      embedding_model: "stub-djb2-1024",
      document_title: "Pricing page",
      source_name: "Acme Corp",
    },
  ],
  mismatchedModels: [],
};

describe("GET /api/intel/search", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req("?q=acme", {}));
    expect(res.status).toBe(401);
    expect(h.searchChunks).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await GET(
      req("?q=acme", { "x-amzn-oidc-data": viewersToken }),
    );
    expect(res.status).toBe(403);
    expect(h.searchChunks).not.toHaveBeenCalled();
  });

  test("400 when q is missing/blank", async () => {
    for (const qs of ["", "?q=", "?q=%20%20"]) {
      const res = await GET(req(qs));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Validation failed");
    }
    expect(h.searchChunks).not.toHaveBeenCalled();
  });

  test("400 when count is out of range or not an integer", async () => {
    for (const count of ["0", "51", "2.5", "abc"]) {
      const res = await GET(req(`?q=acme&count=${count}`));
      expect(res.status).toBe(400);
    }
    expect(h.searchChunks).not.toHaveBeenCalled();
  });

  test("400 when sourceId is not a UUID", async () => {
    const res = await GET(req("?q=acme&sourceId=nope"));
    expect(res.status).toBe(400);
    expect(h.searchChunks).not.toHaveBeenCalled();
  });

  test("200: embeds+matches via the repo with defaults and the user client", async () => {
    h.searchChunks.mockResolvedValue(searchResult);
    const res = await GET(req("?q=acme%20pricing"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.query).toBe("acme pricing");
    expect(json.provider).toEqual({ model: "stub-djb2-1024", dims: 1024 });
    expect(json.results).toEqual(searchResult.rows);
    expect(json.mismatchedModels).toEqual([]);
    expect(h.searchChunks).toHaveBeenCalledWith(
      "acme pricing",
      { sourceId: null, count: 8 },
      userDb,
    );
  });

  test("200: threads sourceId filter and count through", async () => {
    h.searchChunks.mockResolvedValue({ ...searchResult, rows: [] });
    const res = await GET(req(`?q=acme&sourceId=${SOURCE_ID}&count=20`));
    expect(res.status).toBe(200);
    expect(h.searchChunks).toHaveBeenCalledWith(
      "acme",
      { sourceId: SOURCE_ID, count: 20 },
      userDb,
    );
  });

  test("surfaces corpus/query provider mismatches for the UI warning", async () => {
    h.searchChunks.mockResolvedValue({
      ...searchResult,
      mismatchedModels: ["amazon.titan-embed-text-v2:0"],
    });
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(200);
    expect((await res.json()).mismatchedModels).toEqual([
      "amazon.titan-embed-text-v2:0",
    ]);
  });

  test("503 intel-not-provisioned when the substrate is absent", async () => {
    h.searchChunks.mockRejectedValue(
      new NotProvisionedError("search", "PGRST202"),
    );
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("intel-not-provisioned");
  });

  test("503 embedding-not-configured on a bad CI_EMBED_PROVIDER", async () => {
    h.searchChunks.mockRejectedValue(
      new EmbeddingConfigError("CI_EMBED_PROVIDER must be one of: stub, bedrock"),
    );
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("embedding-not-configured");
  });

  test("502 embedding-failed when the provider backend returns garbage", async () => {
    h.searchChunks.mockRejectedValue(
      new EmbeddingProviderError("invalid embedding"),
    );
    const res = await GET(req("?q=acme"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("embedding-failed");
  });
});
