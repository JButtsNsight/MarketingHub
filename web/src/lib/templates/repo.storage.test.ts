import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("../supabase", () => ({
  getServiceClient: () => h.client,
}));

import { createTemplate, getTemplateFile } from "./repo";

interface StorageCalls {
  bucket: string | null;
  uploadPath: string | null;
  uploadBody: unknown;
  uploadOpts: unknown;
  signedPath: string | null;
  signedExpiry: number | null;
  update: Record<string, unknown> | null;
}

/**
 * A mock Supabase client covering BOTH the PostgREST query chain
 * (schema→from→insert/update/select/eq/single/maybeSingle) and the Storage API
 * (storage.from(bucket).upload / .createSignedUrl).
 */
function buildClient(opts: {
  insertRow: Record<string, unknown>;
  updatedRow?: Record<string, unknown>;
  getRow?: Record<string, unknown> | null;
  uploadError?: { message: string } | null;
  signedUrl?: string;
  signedError?: { message: string } | null;
}) {
  const calls: StorageCalls = {
    bucket: null,
    uploadPath: null,
    uploadBody: null,
    uploadOpts: null,
    signedPath: null,
    signedExpiry: null,
    update: null,
  };

  const q: Record<string, unknown> = {};
  // insert/update both return the query for chaining; select→single resolves.
  q.insert = vi.fn(() => q);
  q.update = vi.fn((row: Record<string, unknown>) => {
    calls.update = row;
    return q;
  });
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  // single resolves to the inserted row first, then the updated row.
  let singleCall = 0;
  q.single = vi.fn(() => {
    singleCall++;
    const data = singleCall === 1 ? opts.insertRow : (opts.updatedRow ?? opts.insertRow);
    return Promise.resolve({ data, error: null });
  });
  q.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: opts.getRow ?? null, error: null }),
  );

  const from = vi.fn(() => q);
  const schema = vi.fn(() => ({ from }));

  const storageBucket = {
    upload: vi.fn(
      (path: string, body: unknown, uploadOpts: unknown) => {
        calls.uploadPath = path;
        calls.uploadBody = body;
        calls.uploadOpts = uploadOpts;
        return Promise.resolve({
          data: opts.uploadError ? null : { path },
          error: opts.uploadError ?? null,
        });
      },
    ),
    createSignedUrl: vi.fn((path: string, expiresIn: number) => {
      calls.signedPath = path;
      calls.signedExpiry = expiresIn;
      return Promise.resolve({
        data: opts.signedError ? null : { signedUrl: opts.signedUrl },
        error: opts.signedError ?? null,
      });
    }),
  };
  const storage = {
    from: vi.fn((bucket: string) => {
      calls.bucket = bucket;
      return storageBucket;
    }),
  };

  return { client: { schema, storage }, calls };
}

const input = {
  name: "Newsletter",
  type: "text" as const,
  category: "Newsletter",
  tags: ["news"],
  body: "hello world",
};

describe("repo Storage upload/download", () => {
  beforeEach(() => {
    h.client = null;
  });

  test("createTemplate uploads the file to campaign-templates at <id>/<safe-filename> and persists storage_path", async () => {
    const { client, calls } = buildClient({
      insertRow: { id: "abc123", ...input, storage_path: null },
      updatedRow: {
        id: "abc123",
        ...input,
        storage_path: "abc123/spring_promo.html",
      },
    });
    h.client = client;

    const result = await createTemplate(
      input,
      { email: "amy@nsight.example" },
      { filename: "spring promo.html", content: "<h1>Hi</h1>", contentType: "text/html" },
    );

    expect(calls.bucket).toBe("campaign-templates");
    // filename sanitized; keyed under the row id
    expect(calls.uploadPath).toBe("abc123/spring_promo.html");
    expect(calls.uploadBody).toBe("<h1>Hi</h1>");
    // storage_path written back to the row
    expect(calls.update?.storage_path).toBe("abc123/spring_promo.html");
    expect(result.storage_path).toBe("abc123/spring_promo.html");
  });

  test("createTemplate without a file does not touch Storage", async () => {
    const { client, calls } = buildClient({
      insertRow: { id: "abc123", ...input, storage_path: null },
    });
    h.client = client;

    await createTemplate(input, { email: "amy@nsight.example" });

    expect(calls.bucket).toBeNull();
    expect(calls.uploadPath).toBeNull();
    expect(calls.update).toBeNull();
  });

  test("createTemplate fails loud when the upload errors", async () => {
    const { client } = buildClient({
      insertRow: { id: "abc123", ...input, storage_path: null },
      uploadError: { message: "bucket missing" },
    });
    h.client = client;

    await expect(
      createTemplate(
        input,
        { email: "amy@nsight.example" },
        { filename: "x.txt", content: "hi" },
      ),
    ).rejects.toThrow(/bucket missing/);
  });

  test("getTemplateFile returns a signed URL for the stored path", async () => {
    const { client, calls } = buildClient({
      insertRow: {},
      getRow: {
        id: "abc123",
        ...input,
        storage_path: "abc123/spring_promo.html",
      },
      signedUrl: "https://storage.example/signed/abc123",
    });
    h.client = client;

    const file = await getTemplateFile("abc123");

    expect(calls.signedPath).toBe("abc123/spring_promo.html");
    expect(calls.signedExpiry).toBeGreaterThan(0);
    expect(file?.signedUrl).toBe("https://storage.example/signed/abc123");
  });

  test("getTemplateFile returns null when the template has no stored file", async () => {
    const { client } = buildClient({
      insertRow: {},
      getRow: { id: "abc123", ...input, storage_path: null },
    });
    h.client = client;

    const file = await getTemplateFile("abc123");
    expect(file).toBeNull();
  });
});
