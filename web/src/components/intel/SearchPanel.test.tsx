import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MatchChunkRow } from "@/lib/intel/schema";

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/intel/search",
  useSearchParams: () => nav.params,
}));

import { SearchPanel } from "./SearchPanel";
import { NOT_PROVISIONED_TITLE, STUB_BADGE_TEXT } from "./status";
import type { EmbeddingProviderInfo } from "./types";

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

function match(overrides: Partial<MatchChunkRow> = {}): MatchChunkRow {
  return {
    chunk_id: 7,
    document_id: "33333333-3333-4333-8333-333333333333",
    source_id: "22222222-2222-4222-8222-222222222222",
    seq: 2,
    content: "Enterprise tier is $99 per seat with volume discounts.",
    similarity: 0.872,
    embedding_model: "stub-djb2-1024",
    document_title: "Pricing snapshot",
    source_name: "Acme pricing",
    ...overrides,
  };
}

type Handler = (url: string) => { status: number; body: unknown };

function stubFetch(handler: Handler) {
  const fn = vi.fn((input: RequestInfo | URL) => {
    const { status, body } = handler(String(input));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Routes the filter's sources load + the search call (real envelopes). */
function searchRoutes(rows: MatchChunkRow[], queryModel = "stub-djb2-1024"): Handler {
  return (url) => {
    if (url.startsWith("/api/intel/search")) {
      return {
        status: 200,
        body: {
          query: "q",
          provider: { model: queryModel, dims: 1024 },
          mismatchedModels: rows
            .map((r) => r.embedding_model)
            .filter((m): m is string => m !== null && m !== queryModel),
          results: rows,
        },
      };
    }
    return { status: 200, body: { sources: [], stats: [] } };
  };
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SearchPanel", () => {
  test("starts idle with a prompt and the plainly-labeled stub badge", async () => {
    stubFetch(searchRoutes([]));
    render(<SearchPanel provider={STUB_PROVIDER} />);

    expect(
      await screen.findByText(/semantic search over everything pasted/i),
    ).toBeInTheDocument();
    expect(screen.getByText(STUB_BADGE_TEXT)).toBeInTheDocument();
  });

  test("submitting a query calls the search API and renders similarity + provenance", async () => {
    const fetchFn = stubFetch(searchRoutes([match()]));
    const user = userEvent.setup();
    render(<SearchPanel provider={STUB_PROVIDER} />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "pricing tiers",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByText(/cosine 0\.872/i)).toBeInTheDocument();
    expect(screen.getByText(/chunk #2/)).toBeInTheDocument();
    expect(screen.getByText(/acme pricing/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /pricing snapshot/i }),
    ).toHaveAttribute("href", "/intel/documents/33333333-3333-4333-8333-333333333333");
    expect(screen.getByText(/enterprise tier is \$99/i)).toBeInTheDocument();

    const searchCall = fetchFn.mock.calls.find(([u]) =>
      String(u).startsWith("/api/intel/search"),
    );
    expect(String(searchCall![0])).toContain("q=pricing+tiers");
    // The query is written to the URL (shareable, q-param precedent).
    expect(nav.replace).toHaveBeenCalledWith("/intel/search?q=pricing+tiers");
  });

  test("auto-runs a query that arrives in the URL", async () => {
    nav.params = new URLSearchParams("q=alpha");
    stubFetch(searchRoutes([match()]));
    render(<SearchPanel provider={STUB_PROVIDER} />);
    expect(await screen.findByText(/cosine 0\.872/i)).toBeInTheDocument();
  });

  test("zero matches renders an honest empty state naming embedding lag", async () => {
    stubFetch(searchRoutes([]));
    const user = userEvent.setup();
    render(<SearchPanel provider={STUB_PROVIDER} />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "unheard of",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
    expect(screen.getByText(/may still be awaiting embedding/i)).toBeInTheDocument();
  });

  test("warns when corpus rows were embedded with a different model", async () => {
    stubFetch(
      searchRoutes(
        [match({ embedding_model: "stub-djb2-1024" })],
        "amazon.titan-embed-text-v2:0",
      ),
    );
    const user = userEvent.setup();
    render(<SearchPanel provider={BEDROCK_PROVIDER} />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "pricing",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(
      await screen.findByText(/similarity is not comparable across models/i),
    ).toBeInTheDocument();
    expect(screen.getByText("stub-djb2-1024")).toBeInTheDocument();
  });

  test("renders the not-provisioned state on a 503", async () => {
    stubFetch((url) =>
      url.startsWith("/api/intel/search")
        ? {
            status: 503,
            body: { error: "intel-not-provisioned", message: "schema not applied" },
          }
        : { status: 200, body: { sources: [], stats: [] } },
    );
    const user = userEvent.setup();
    render(<SearchPanel provider={STUB_PROVIDER} />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "anything",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByText(NOT_PROVISIONED_TITLE)).toBeInTheDocument();
  });

  test("degraded search failures show the API error and keep the box usable", async () => {
    stubFetch((url) =>
      url.startsWith("/api/intel/search")
        ? {
            status: 502,
            body: {
              error: "embedding-failed",
              message: "embedding provider unavailable",
            },
          }
        : { status: 200, body: { sources: [], stats: [] } },
    );
    const user = userEvent.setup();
    render(<SearchPanel provider={BEDROCK_PROVIDER} />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "anything",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /embedding provider unavailable/i,
    );
    expect(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
    ).toBeInTheDocument();
  });

  test("renders a negative similarity honestly (signed cosine, never a negative percent)", async () => {
    stubFetch(searchRoutes([match({ similarity: -0.083 })]));
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel provider={STUB_PROVIDER} />);
    expect(await screen.findByText(/cosine -0\.083/i)).toBeInTheDocument();
  });

  test("drops a URL sourceId that no longer exists, says so, and re-runs unfiltered", async () => {
    nav.params = new URLSearchParams(
      "q=pricing&sourceId=99999999-9999-4999-8999-999999999999",
    );
    const fetchFn = stubFetch((url) => {
      if (url.startsWith("/api/intel/search")) {
        return {
          status: 200,
          body: {
            query: "pricing",
            provider: { model: "stub-djb2-1024", dims: 1024 },
            mismatchedModels: [],
            results: [match()],
          },
        };
      }
      // The dead uuid is not in the loaded list.
      return {
        status: 200,
        body: {
          sources: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Acme pricing",
              kind: "text",
              url: null,
              notes: null,
              created_by: null,
              created_at: "2026-08-08T12:00:00Z",
              updated_at: "2026-08-08T12:00:00Z",
            },
          ],
          stats: [],
        },
      };
    });
    render(<SearchPanel provider={STUB_PROVIDER} />);

    // Visible notice, not a silent perpetual "No matches".
    expect(
      await screen.findByText(/source filter from this link no longer exists/i),
    ).toBeInTheDocument();
    // The re-run search call carries NO sourceId.
    const searchCalls = fetchFn.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.startsWith("/api/intel/search"));
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(searchCalls[searchCalls.length - 1]).not.toContain("sourceId");
  });

  test("surfaces an active URL filter as text when the sources list fails to load", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    nav.params = new URLSearchParams(`sourceId=${sourceId}`);
    stubFetch((url) =>
      url.startsWith("/api/intel/search")
        ? { status: 200, body: { results: [] } }
        : { status: 500, body: { error: "boom" } },
    );
    const user = userEvent.setup();
    render(<SearchPanel provider={STUB_PROVIDER} />);

    // The dropdown cannot render, so the filter is shown as text with an
    // escape hatch — never an invisible restriction on every search.
    expect(
      await screen.findByText(/results are filtered to one source/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /clear filter/i }));
    expect(
      screen.queryByText(/results are filtered to one source/i),
    ).not.toBeInTheDocument();
  });

  test("filters by source when one is picked", async () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const fetchFn = stubFetch((url) => {
      if (url.startsWith("/api/intel/search")) {
        return {
          status: 200,
          body: {
            query: "pricing",
            provider: { model: "stub-djb2-1024", dims: 1024 },
            mismatchedModels: [],
            results: [match()],
          },
        };
      }
      return {
        status: 200,
        body: {
          sources: [
            {
              id: sourceId,
              name: "Acme pricing",
              kind: "text",
              url: null,
              notes: null,
              created_by: null,
              created_at: "2026-08-08T12:00:00Z",
              updated_at: "2026-08-08T12:00:00Z",
            },
          ],
          stats: [],
        },
      };
    });
    const user = userEvent.setup();
    render(<SearchPanel provider={STUB_PROVIDER} />);

    await user.selectOptions(
      await screen.findByRole("combobox", { name: /filter by source/i }),
      sourceId,
    );
    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "pricing",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    await screen.findByText(/cosine 0\.872/i);
    const searchCall = fetchFn.mock.calls.find(([u]) =>
      String(u).startsWith("/api/intel/search"),
    );
    expect(String(searchCall![0])).toContain(`sourceId=${sourceId}`);
  });
});
