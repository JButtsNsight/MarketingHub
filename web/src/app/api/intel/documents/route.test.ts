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
import { DOCUMENT_CONTENT_MAX_CHARS } from "@/lib/intel/schema";

const h = vi.hoisted(() => ({
  createDocument: vi.fn(),
  getSource: vi.fn(),
  listDocumentsBySource: vi.fn(),
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
    createDocument: h.createDocument,
    getSource: h.getSource,
    listDocumentsBySource: h.listDocumentsBySource,
  };
});

import { NotProvisionedError } from "@/lib/intel/repo";
import { GET, POST } from "./route";

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
  return new Request("http://x/api/intel/documents", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = {
  sourceId: SOURCE_ID,
  title: "Pricing page",
  content: "## Pricing\nAcme charges $99.",
};

describe("POST /api/intel/documents (paste-text only)", () => {
  test("401 when unauthenticated", async () => {
    const res = await POST(
      postReq(validBody, { "content-type": "application/json" }),
    );
    expect(res.status).toBe(401);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("403 when missing the marketing group", async () => {
    const res = await POST(
      postReq(validBody, {
        "x-amzn-oidc-data": viewersToken,
        "content-type": "application/json",
      }),
    );
    expect(res.status).toBe(403);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("400 when sourceId is not a UUID", async () => {
    const res = await POST(postReq({ ...validBody, sourceId: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("400 when content is blank", async () => {
    const res = await POST(postReq({ ...validBody, content: "   \n " }));
    expect(res.status).toBe(400);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("400 when content exceeds the paste ceiling", async () => {
    const res = await POST(
      postReq({
        ...validBody,
        content: "x".repeat(DOCUMENT_CONTENT_MAX_CHARS + 1),
      }),
    );
    expect(res.status).toBe(400);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("413 when the request BODY exceeds the byte cap (bounded read, never buffered whole)", async () => {
    // Over the 3 MiB envelope cap — readJsonBodyBounded rejects on the
    // declared Content-Length / stream cap BEFORE parsing, so a multi-GB
    // body can never be buffered into the shared app container (OOM lever).
    const res = await POST(postReq("x".repeat(3 * 1024 * 1024 + 1)));
    expect(res.status).toBe(413);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("a maximum-size legitimate paste clears the byte cap (413 never fires on valid input)", async () => {
    h.getSource.mockResolvedValue({ id: SOURCE_ID, name: "Acme" });
    h.createDocument.mockResolvedValue({
      id: "d2",
      source_id: SOURCE_ID,
      status: "pending",
    });
    const res = await POST(
      postReq({ ...validBody, content: "y".repeat(DOCUMENT_CONTENT_MAX_CHARS) }),
    );
    expect(res.status).toBe(201);
  });

  test("400 on invalid JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("404 when the source does not exist (no raw FK violation)", async () => {
    h.getSource.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(h.createDocument).not.toHaveBeenCalled();
  });

  test("201: inserts the pasted document via the repo with the user client", async () => {
    h.getSource.mockResolvedValue({ id: SOURCE_ID, name: "Acme" });
    h.createDocument.mockResolvedValue({
      id: "d1",
      source_id: SOURCE_ID,
      status: "pending",
    });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("d1");
    expect(json.document.status).toBe("pending");
    expect(h.createDocument).toHaveBeenCalledWith(
      {
        sourceId: SOURCE_ID,
        title: "Pricing page",
        content: "## Pricing\nAcme charges $99.",
      },
      userDb,
    );
  });

  test("503 intel-not-provisioned when the substrate is absent", async () => {
    h.getSource.mockRejectedValue(
      new NotProvisionedError("get-source", "PGRST106"),
    );
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("intel-not-provisioned");
  });
});

describe("GET /api/intel/documents", () => {
  test("400 when sourceId is missing or not a UUID", async () => {
    for (const qs of ["", "?sourceId=nope"]) {
      const res = await GET(
        new Request(`http://x/api/intel/documents${qs}`, {
          headers: marketingHeaders(),
        }),
      );
      expect(res.status).toBe(400);
    }
    expect(h.listDocumentsBySource).not.toHaveBeenCalled();
  });

  test("200 with the source's document summaries", async () => {
    const docs = [{ id: "d1", title: "Pricing page", chunk_count: 4 }];
    h.listDocumentsBySource.mockResolvedValue(docs);
    const res = await GET(
      new Request(`http://x/api/intel/documents?sourceId=${SOURCE_ID}`, {
        headers: marketingHeaders(),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).documents).toEqual(docs);
    expect(h.listDocumentsBySource).toHaveBeenCalledWith(SOURCE_ID, userDb);
  });
});
