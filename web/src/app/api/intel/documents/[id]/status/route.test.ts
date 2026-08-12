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
  chunkStatus: vi.fn(),
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
  return { ...actual, chunkStatus: h.chunkStatus };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { GET } from "./route";

const DOC_ID = "9a1b2c3d-0000-4111-8222-333344445555";

let intelToken: string;
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
  intelToken = await signAlbToken({
    email: "amy@nsight.example",
    "cognito:groups": ["mh-section-intel"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  h.chunkStatus.mockReset();
});

afterEach(() => {
  clearAlbEnv();
});

function req(headers?: HeadersInit) {
  return new Request(`http://x/api/intel/documents/${DOC_ID}/status`, {
    headers: headers ?? { "x-amzn-oidc-data": intelToken },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/intel/documents/[id]/status", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req({}), params(DOC_ID));
    expect(res.status).toBe(401);
    expect(h.chunkStatus).not.toHaveBeenCalled();
  });

  test("403 for base marketing without the section; admins pass", async () => {
    const forbidden = await GET(
      req({ "x-amzn-oidc-data": marketingToken }),
      params(DOC_ID),
    );
    expect(forbidden.status).toBe(403);
    expect(h.chunkStatus).not.toHaveBeenCalled();

    h.chunkStatus.mockResolvedValue({ document_id: DOC_ID, status: "processing" });
    const admin = await GET(
      req({ "x-amzn-oidc-data": adminToken }),
      params(DOC_ID),
    );
    expect(admin.status).toBe(200);
  });

  test("404 on a non-UUID id without touching PostgREST", async () => {
    const res = await GET(req(), params("nope"));
    expect(res.status).toBe(404);
    expect(h.chunkStatus).not.toHaveBeenCalled();
  });

  test("404 when the document does not exist", async () => {
    h.chunkStatus.mockResolvedValue(null);
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(404);
  });

  test("200 with the honest embedding progress", async () => {
    const status = {
      document_id: DOC_ID,
      status: "processing",
      error: null,
      chunk_count: 3,
      embedded_count: 2,
      embedding_models: ["stub-djb2-1024"],
      last_embedded_at: "2026-08-08T02:00:00Z",
    };
    h.chunkStatus.mockResolvedValue(status);
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toEqual(status);
    expect(h.chunkStatus).toHaveBeenCalledWith(DOC_ID, userDb);
  });

  test("503 intel-not-provisioned", async () => {
    h.chunkStatus.mockRejectedValue(
      new NotProvisionedError("chunk-status", "PGRST205"),
    );
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("intel-not-provisioned");
  });
});
