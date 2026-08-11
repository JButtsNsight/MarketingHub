import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntelSource } from "@/lib/intel/schema";

import { SourceDetail } from "./SourceDetail";
import { NOT_PROVISIONED_TITLE, STUB_BADGE_TEXT } from "./status";
import type { EmbeddingProviderInfo, IntelDocumentSummary } from "./types";

const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const STUB_PROVIDER: EmbeddingProviderInfo = {
  provider: "stub",
  model: "stub-djb2-1024",
  stub: true,
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function stubFetch(handler: Handler) {
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function src(overrides: Partial<IntelSource> = {}): IntelSource {
  return {
    id: SOURCE_ID,
    name: "Acme pricing",
    kind: "text",
    url: null,
    notes: "watch their enterprise tier",
    created_by: null,
    created_at: "2026-08-08T12:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
    ...overrides,
  };
}

function doc(
  id: string,
  status: IntelDocumentSummary["status"],
  overrides: Partial<IntelDocumentSummary> = {},
): IntelDocumentSummary {
  return {
    id,
    source_id: SOURCE_ID,
    title: `Doc ${id}`,
    status,
    error: null,
    created_at: "2026-08-08T12:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
    chunk_count: 0,
    ...overrides,
  };
}

/** The real route shape: GET /api/intel/sources/:id → { source, documents }. */
function routes(documents: IntelDocumentSummary[], sourceRow = src()): Handler {
  return (url, init) => {
    if ((init?.method ?? "GET") === "POST") return { status: 201, body: { id: "new" } };
    return { status: 200, body: { source: sourceRow, documents } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourceDetail", () => {
  test("renders documents with lifecycle pills, chunk counts, and error detail", async () => {
    stubFetch(
      routes([
        doc("d1", "pending"),
        doc("d2", "embedded", { chunk_count: 5 }),
        doc("d3", "error", { error: "provider exploded" }),
      ]),
    );
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);

    expect(await screen.findByText("pending")).toBeInTheDocument();
    expect(screen.getByText("embedded")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("provider exploded")).toBeInTheDocument();
    // Honest queue-drain note while anything is pending/processing.
    expect(screen.getByText(/1 awaiting embedding/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on the embedding worker/i)).toBeInTheDocument();
  });

  test("labels stub mode plainly", async () => {
    stubFetch(routes([doc("d1", "embedded")]));
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);
    expect(await screen.findByText(STUB_BADGE_TEXT)).toBeInTheDocument();
  });

  test("labels a url-kind source's deferred fetch honestly", async () => {
    stubFetch(routes([], src({ kind: "url", url: "https://acme.example/pricing" })));
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);
    expect(
      await screen.findByText(/URL fetch: follow-up pending SSRF guardrails/i),
    ).toBeInTheDocument();
    expect(screen.getByText("https://acme.example/pricing")).toBeInTheDocument();
  });

  test("renders the empty documents state", async () => {
    stubFetch(routes([]));
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);
    expect(await screen.findByText(/no documents yet/i)).toBeInTheDocument();
  });

  test("renders the not-provisioned state on the route's honest 503", async () => {
    stubFetch(() => ({
      status: 503,
      body: { error: "intel-not-provisioned", message: "schema not applied" },
    }));
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);
    expect(await screen.findByText(NOT_PROVISIONED_TITLE)).toBeInTheDocument();
  });

  test("pastes a document via POST /api/intel/documents", async () => {
    const fetchFn = stubFetch(routes([]));
    const user = userEvent.setup();
    render(<SourceDetail sourceId={SOURCE_ID} provider={STUB_PROVIDER} />);

    await user.click(await screen.findByRole("button", { name: /paste a document/i }));
    await user.type(screen.getByLabelText(/title/i), "Pricing snapshot");
    await user.type(screen.getByLabelText(/content/i), "Enterprise tier is $99.");
    await user.click(screen.getByRole("button", { name: /add document/i }));

    await waitFor(() => {
      const post = fetchFn.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeTruthy();
      expect(String(post![0])).toBe("/api/intel/documents");
      expect(JSON.parse(post![1]?.body as string)).toMatchObject({
        sourceId: SOURCE_ID,
        title: "Pricing snapshot",
        content: "Enterprise tier is $99.",
      });
    });
  });
});
