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
  getSource: vi.fn(),
  listDocumentsBySource: vi.fn(),
  updateSource: vi.fn(),
  deleteSource: vi.fn(),
}));

const userDb = vi.hoisted(() => ({}));

vi.mock("@/lib/supabase", () => ({
  getUserClient: async () => userDb,
  getServiceClient: () => {
    throw new Error("routes must use the user client, not the service client");
  },
}));

vi.mock("@/lib/intel/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/intel/repo")>();
  return {
    ...actual,
    getSource: h.getSource,
    listDocumentsBySource: h.listDocumentsBySource,
    updateSource: h.updateSource,
    deleteSource: h.deleteSource,
  };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { DELETE, GET, PATCH } from "./route";

const SOURCE_ID = "5f5e8c2a-9d1b-4f3a-8a51-51e6dd2e1a01";

let marketingToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["marketing"],
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

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(method: string, body?: unknown, headers?: HeadersInit) {
  return new Request(`http://x/api/intel/sources/${SOURCE_ID}`, {
    method,
    headers: headers ?? marketingHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const sourceRow = { id: SOURCE_ID, name: "Acme Corp", kind: "text" };

describe("GET /api/intel/sources/[id]", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(
      new Request(`http://x/api/intel/sources/${SOURCE_ID}`),
      params(SOURCE_ID),
    );
    expect(res.status).toBe(401);
    expect(h.getSource).not.toHaveBeenCalled();
  });

  test("404 on a non-UUID id without touching PostgREST", async () => {
    const res = await GET(req("GET"), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.getSource).not.toHaveBeenCalled();
  });

  test("404 when the source does not exist", async () => {
    h.getSource.mockResolvedValue(null);
    const res = await GET(req("GET"), params(SOURCE_ID));
    expect(res.status).toBe(404);
    expect(h.listDocumentsBySource).not.toHaveBeenCalled();
  });

  test("200 with the source plus its document summaries", async () => {
    h.getSource.mockResolvedValue(sourceRow);
    h.listDocumentsBySource.mockResolvedValue([
      { id: "d1", title: "Pricing page", status: "embedded", chunk_count: 4 },
    ]);
    const res = await GET(req("GET"), params(SOURCE_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toEqual(sourceRow);
    expect(json.documents).toHaveLength(1);
    expect(h.getSource).toHaveBeenCalledWith(SOURCE_ID, userDb);
    expect(h.listDocumentsBySource).toHaveBeenCalledWith(SOURCE_ID, userDb);
  });

  test("503 intel-not-provisioned", async () => {
    h.getSource.mockRejectedValue(new NotProvisionedError("get-source", "42P01"));
    const res = await GET(req("GET"), params(SOURCE_ID));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("intel-not-provisioned");
  });
});

describe("PATCH /api/intel/sources/[id]", () => {
  test("400 on an empty patch (zod rejects it)", async () => {
    const res = await PATCH(req("PATCH", {}), params(SOURCE_ID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    expect(h.updateSource).not.toHaveBeenCalled();
  });

  test("413 when the patch body exceeds the 256KB envelope cap (bounded read before parse)", async () => {
    const res = await PATCH(
      new Request(`http://x/api/intel/sources/${SOURCE_ID}`, {
        method: "PATCH",
        headers: marketingHeaders(),
        body: "x".repeat(256 * 1024 + 1),
      }),
      params(SOURCE_ID),
    );
    expect(res.status).toBe(413);
    expect(h.updateSource).not.toHaveBeenCalled();
  });

  test("400 on an invalid url value", async () => {
    const res = await PATCH(
      req("PATCH", { url: "ftp://acme.example" }),
      params(SOURCE_ID),
    );
    expect(res.status).toBe(400);
    expect(h.updateSource).not.toHaveBeenCalled();
  });

  test("200: patches via the repo (null clears url)", async () => {
    h.updateSource.mockResolvedValue({ ...sourceRow, url: null });
    const res = await PATCH(
      req("PATCH", { name: "Acme Inc", url: null }),
      params(SOURCE_ID),
    );
    expect(res.status).toBe(200);
    expect(h.updateSource).toHaveBeenCalledWith(
      SOURCE_ID,
      { name: "Acme Inc", url: null },
      userDb,
    );
  });

  test("404 when the update matches nothing", async () => {
    h.updateSource.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", { name: "Acme" }), params(SOURCE_ID));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/intel/sources/[id]", () => {
  test("204 on success", async () => {
    h.deleteSource.mockResolvedValue(true);
    const res = await DELETE(req("DELETE"), params(SOURCE_ID));
    expect(res.status).toBe(204);
    expect(h.deleteSource).toHaveBeenCalledWith(SOURCE_ID, userDb);
  });

  test("404 when nothing matched", async () => {
    h.deleteSource.mockResolvedValue(false);
    const res = await DELETE(req("DELETE"), params(SOURCE_ID));
    expect(res.status).toBe(404);
  });

  test("404 on a non-UUID id without touching PostgREST", async () => {
    const res = await DELETE(req("DELETE"), params("../etc"));
    expect(res.status).toBe(404);
    expect(h.deleteSource).not.toHaveBeenCalled();
  });
});
