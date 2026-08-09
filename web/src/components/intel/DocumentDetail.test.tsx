import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { IntelDocument } from "@/lib/intel/schema";

import { DocumentDetail } from "./DocumentDetail";
import { NOT_PROVISIONED_TITLE, STUB_BADGE_TEXT } from "./status";
import type { EmbeddingProviderInfo } from "./types";

const DOC_ID = "33333333-3333-4333-8333-333333333333";

const STUB_PROVIDER: EmbeddingProviderInfo = {
  provider: "stub",
  model: "stub-djb2-1024",
  stub: true,
};

const BEDROCK_PROVIDER: EmbeddingProviderInfo = {
  provider: "bedrock",
  model: "amazon.titan-embed-text-v2:0",
  stub: false,
};

/** ChunkStatus payload of GET /api/intel/documents/:id/status. */
interface StatusBody {
  document_id: string;
  status: IntelDocument["status"];
  error: string | null;
  chunk_count: number;
  embedded_count: number;
  embedding_models: string[];
  last_embedded_at: string | null;
}

function doc(
  status: IntelDocument["status"],
  overrides: Partial<IntelDocument> = {},
): IntelDocument {
  return {
    id: DOC_ID,
    source_id: "22222222-2222-4222-8222-222222222222",
    title: "Pricing snapshot",
    content: "# Pricing\n\nEnterprise tier is $99.",
    status,
    error: null,
    created_at: "2026-08-08T12:00:00Z",
    updated_at: "2026-08-08T12:05:00Z",
    ...overrides,
  };
}

function chunkStatus(overrides: Partial<StatusBody> = {}): StatusBody {
  return {
    document_id: DOC_ID,
    status: "embedded",
    error: null,
    chunk_count: 12,
    embedded_count: 12,
    embedding_models: ["stub-djb2-1024"],
    last_embedded_at: "2026-08-08T12:04:00Z",
    ...overrides,
  };
}

/** Routes the document GET and its /status sibling. */
function stubFetch(
  document: { status: number; body: unknown },
  status: { status: number; body: unknown },
) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const res = url.endsWith("/status") ? status : document;
    return Promise.resolve({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: () => Promise.resolve(res.body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocumentDetail", () => {
  test("shows the pasted content, chunk progress, and the corpus model", async () => {
    stubFetch(
      { status: 200, body: { document: doc("embedded") } },
      { status: 200, body: { status: chunkStatus() } },
    );
    render(<DocumentDetail documentId={DOC_ID} provider={STUB_PROVIDER} />);

    expect(await screen.findByText("Pricing snapshot")).toBeInTheDocument();
    expect(screen.getByText(/enterprise tier is \$99/i)).toBeInTheDocument();
    expect(screen.getByText("12/12 embedded")).toBeInTheDocument();
    expect(screen.getByText("stub-djb2-1024")).toBeInTheDocument();
    // Stub-embedded corpus is labeled plainly.
    expect(screen.getByText(STUB_BADGE_TEXT)).toBeInTheDocument();
  });

  test("shows an honest pending state while the queue drains", async () => {
    stubFetch(
      { status: 200, body: { document: doc("pending") } },
      {
        status: 200,
        body: {
          status: chunkStatus({
            status: "pending",
            chunk_count: 0,
            embedded_count: 0,
            embedding_models: [],
            last_embedded_at: null,
          }),
        },
      },
    );
    render(<DocumentDetail documentId={DOC_ID} provider={BEDROCK_PROVIDER} />);

    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.getByText(/waiting on the embedding worker/i)).toBeInTheDocument();
    expect(screen.getByText("0/0 embedded")).toBeInTheDocument();
  });

  test("degrades to 'not reported' when the status endpoint fails", async () => {
    stubFetch(
      { status: 200, body: { document: doc("processing") } },
      { status: 500, body: { error: "status query failed" } },
    );
    render(<DocumentDetail documentId={DOC_ID} provider={BEDROCK_PROVIDER} />);
    expect(await screen.findByText("not reported")).toBeInTheDocument();
    expect(screen.getByText("processing")).toBeInTheDocument();
  });

  test("surfaces the consumer's error message verbatim", async () => {
    stubFetch(
      {
        status: 200,
        body: { document: doc("error", { error: "Bedrock throttled after 3 attempts" }) },
      },
      {
        status: 200,
        body: {
          status: chunkStatus({
            status: "error",
            error: "Bedrock throttled after 3 attempts",
            chunk_count: 0,
            embedded_count: 0,
            embedding_models: [],
            last_embedded_at: null,
          }),
        },
      },
    );
    render(<DocumentDetail documentId={DOC_ID} provider={BEDROCK_PROVIDER} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /embedding failed: bedrock throttled after 3 attempts/i,
    );
  });

  test("renders the not-provisioned state on the route's honest 503", async () => {
    const notProvisioned = {
      status: 503,
      body: { error: "intel-not-provisioned", message: "schema not applied" },
    };
    stubFetch(notProvisioned, notProvisioned);
    render(<DocumentDetail documentId={DOC_ID} provider={BEDROCK_PROVIDER} />);
    expect(await screen.findByText(NOT_PROVISIONED_TITLE)).toBeInTheDocument();
  });
});
