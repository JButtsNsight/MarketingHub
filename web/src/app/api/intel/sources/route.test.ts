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
  createSource: vi.fn(),
  listSources: vi.fn(),
  listSourceStats: vi.fn(),
}));

// Sentinel client threaded by the route into every repo call (Wave 4 style).
const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
  getServiceClient: () => {
    throw new Error("routes must use the user client, not the service client");
  },
}));

// Partial mock: fns stubbed, NotProvisionedError stays the REAL class so the
// route's instanceof mapping is exercised.
vi.mock("@/lib/intel/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/repo")>();
  return {
    ...actual,
    createSource: h.createSource,
    listSources: h.listSources,
    listSourceStats: h.listSourceStats,
  };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { GET, POST } from "./route";

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
  for (const fn of Object.values(h)) fn.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function marketingHeaders(): HeadersInit {
  return {
    "x-amzn-oidc-data": marketingToken,
    "content-type": "application/json",
  };
}

function postReq(body: unknown, headers: HeadersInit = marketingHeaders()) {
  return new Request("http://x/api/intel/sources", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const sourceRow = {
  id: "5f5e8c2a-9d1b-4f3a-8a51-51e6dd2e1a01",
  name: "Acme Corp",
  kind: "text",
  url: null,
  notes: null,
};

describe("POST /api/intel/sources", () => {
  test("401 when unauthenticated", async () => {
    const res = await POST(
      postReq({ name: "Acme" }, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      postReq(
        { name: "Acme" },
        {
          "x-amzn-oidc-data": viewersToken,
          "content-type": "application/json",
        },
      ),
    );
    expect(res.status).toBe(403);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("400 with zod issues when name is missing", async () => {
    const res = await POST(postReq({ kind: "text" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
    expect(json.issues).toBeTruthy();
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("413 when the request body exceeds the 256KB envelope cap (bounded read before parse)", async () => {
    const res = await POST(postReq("x".repeat(256 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("400 when kind='url' but url is missing", async () => {
    const res = await POST(postReq({ name: "Acme", kind: "url" }));
    expect(res.status).toBe(400);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("400 when url has a non-http(s) scheme", async () => {
    const res = await POST(
      postReq({ name: "Acme", kind: "url", url: "file:///etc/passwd" }),
    );
    expect(res.status).toBe(400);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("400 on invalid JSON body", async () => {
    const res = await POST(postReq("{nope"));
    expect(res.status).toBe(400);
    expect(h.createSource).not.toHaveBeenCalled();
  });

  test("201: creates via the repo with the parsed input and the user client", async () => {
    h.createSource.mockResolvedValue(sourceRow);
    const res = await POST(
      postReq({ name: "  Acme Corp  ", notes: "" }),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe(sourceRow.id);
    expect(json.source).toEqual(sourceRow);
    expect(h.createSource).toHaveBeenCalledWith(
      { name: "Acme Corp", kind: "text", url: null, notes: null },
      userDb,
    );
  });

  test("503 intel-not-provisioned when the substrate is absent", async () => {
    h.createSource.mockRejectedValue(
      new NotProvisionedError("create-source", "PGRST106"),
    );
    const res = await POST(postReq({ name: "Acme" }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("intel-not-provisioned");
  });
});

describe("GET /api/intel/sources", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(new Request("http://x/api/intel/sources"));
    expect(res.status).toBe(401);
    expect(h.listSources).not.toHaveBeenCalled();
  });

  test("200 with sources + per-source stats", async () => {
    h.listSources.mockResolvedValue([sourceRow]);
    h.listSourceStats.mockResolvedValue([
      {
        source_id: sourceRow.id,
        document_count: 2,
        chunk_count: 7,
        embedded_document_count: 1,
      },
    ]);
    const res = await GET(
      new Request("http://x/api/intel/sources", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sources).toEqual([sourceRow]);
    expect(json.stats[0].chunk_count).toBe(7);
    expect(h.listSources).toHaveBeenCalledWith(userDb);
    expect(h.listSourceStats).toHaveBeenCalledWith(userDb);
  });

  test("503 intel-not-provisioned when the substrate is absent", async () => {
    h.listSources.mockRejectedValue(
      new NotProvisionedError("list-sources", "PGRST106"),
    );
    h.listSourceStats.mockResolvedValue([]);
    const res = await GET(
      new Request("http://x/api/intel/sources", { headers: marketingHeaders() }),
    );
    expect(res.status).toBe(503);
  });
});
