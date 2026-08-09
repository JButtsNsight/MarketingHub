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
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
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
    getDocument: h.getDocument,
    deleteDocument: h.deleteDocument,
  };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { DELETE, GET } from "./route";

const DOC_ID = "9a1b2c3d-0000-4111-8222-333344445555";

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

function req(method = "GET", headers?: HeadersInit) {
  return new Request(`http://x/api/intel/documents/${DOC_ID}`, {
    method,
    headers: headers ?? { "x-amzn-oidc-data": marketingToken },
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/intel/documents/[id]", () => {
  test("401 when unauthenticated", async () => {
    const res = await GET(req("GET", {}), params(DOC_ID));
    expect(res.status).toBe(401);
    expect(h.getDocument).not.toHaveBeenCalled();
  });

  test("404 on a non-UUID id without touching PostgREST", async () => {
    const res = await GET(req(), params("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(h.getDocument).not.toHaveBeenCalled();
  });

  test("404 when the document does not exist", async () => {
    h.getDocument.mockResolvedValue(null);
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(404);
  });

  test("200 with the full document row", async () => {
    const doc = { id: DOC_ID, title: "Pricing page", content: "## Pricing" };
    h.getDocument.mockResolvedValue(doc);
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).document).toEqual(doc);
    expect(h.getDocument).toHaveBeenCalledWith(DOC_ID, userDb);
  });

  test("503 intel-not-provisioned", async () => {
    h.getDocument.mockRejectedValue(
      new NotProvisionedError("get-document", "42P01"),
    );
    const res = await GET(req(), params(DOC_ID));
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/intel/documents/[id]", () => {
  test("204 on success", async () => {
    h.deleteDocument.mockResolvedValue(true);
    const res = await DELETE(req("DELETE"), params(DOC_ID));
    expect(res.status).toBe(204);
    expect(h.deleteDocument).toHaveBeenCalledWith(DOC_ID, userDb);
  });

  test("404 when nothing matched", async () => {
    h.deleteDocument.mockResolvedValue(false);
    const res = await DELETE(req("DELETE"), params(DOC_ID));
    expect(res.status).toBe(404);
  });
});
