import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ANSWER_POLL_DEADLINE_MS,
  ANSWER_POLL_INTERVAL_MS,
  type AnswerResponse,
  type FtsChunkRow,
  type SearchResponse,
} from "@/lib/intel/schema";

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
import {
  ANSWER_DISCLAIMER_TEXT,
  KEYWORD_ONLY_TEXT,
  NOT_PROVISIONED_TITLE,
  STUB_BADGE_TEXT,
  SYNTHESIS_FAILED_TEXT,
  SYNTHESIS_PENDING_TEXT,
  SYNTHESIS_TIMEOUT_TEXT,
} from "./status";

const TASK_ID = "mh-intel-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fts(overrides: Partial<FtsChunkRow> = {}): FtsChunkRow {
  return {
    chunk_id: 7,
    document_id: "33333333-3333-4333-8333-333333333333",
    source_id: "22222222-2222-4222-8222-222222222222",
    seq: 2,
    content: "Enterprise tier is $99 per seat with volume discounts.",
    rank: 0.372,
    document_title: "Pricing snapshot",
    source_name: "Acme pricing",
    ...overrides,
  };
}

/** Three distinct passages so rerank/citation mapping is observable. */
function threeRows(): FtsChunkRow[] {
  return [
    fts({ chunk_id: 1, rank: 0.9, document_title: "Doc one", content: "alpha content" }),
    fts({
      chunk_id: 2,
      rank: 0.5,
      document_title: "Doc two",
      document_id: "44444444-4444-4444-8444-444444444444",
      content: "beta content",
    }),
    fts({
      chunk_id: 3,
      rank: 0.1,
      document_title: "Doc three",
      document_id: "55555555-5555-4555-8555-555555555555",
      content: "gamma content",
    }),
  ];
}

function keywordOnly(rows: FtsChunkRow[], q = "q"): SearchResponse {
  return {
    query: q,
    mode: "keyword-only",
    results: rows,
    answer: null,
    degraded: rows.length > 0 ? { reason: "gateway-not-configured" } : null,
  };
}

function agenticPending(rows: FtsChunkRow[], q = "q"): SearchResponse {
  return {
    query: q,
    mode: "agentic",
    results: rows,
    answer: { state: "pending", taskId: TASK_ID },
    degraded: null,
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

/** Routes sources load + search + answer poll (real envelopes). */
function routes(
  search: SearchResponse | { status: number; body: unknown },
  answer: AnswerResponse | { status: number; body: unknown } = { state: "pending" },
): Handler {
  return (url) => {
    if (url.startsWith("/api/intel/search/answer/")) {
      return "status" in answer && "body" in answer
        ? answer
        : { status: 200, body: answer };
    }
    if (url.startsWith("/api/intel/search")) {
      return "status" in search && "body" in search
        ? (search as { status: number; body: unknown })
        : { status: 200, body: search };
    }
    return { status: 200, body: { sources: [], stats: [] } };
  };
}

/** Flush pending microtasks (mocked fetch resolves without timers). */
async function flush() {
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function answerUrls(fn: ReturnType<typeof stubFetch>): string[] {
  return fn.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.startsWith("/api/intel/search/answer/"));
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.params = new URLSearchParams();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SearchPanel — keyword phase", () => {
  test("starts idle with just the search controls and NO stub-embeddings badge", async () => {
    stubFetch(routes(keywordOnly([])));
    render(<SearchPanel />);

    expect(
      await screen.findByRole("searchbox", { name: /search competitor intel/i }),
    ).toBeInTheDocument();
    // The embedding pipeline left this surface entirely (it stays on the
    // document/source pages, where it is the honest dormant-parity badge).
    expect(screen.queryByText(STUB_BADGE_TEXT)).not.toBeInTheDocument();
  });

  test("submit renders numbered passages with rank + provenance and updates the URL", async () => {
    const fetchFn = stubFetch(routes(keywordOnly([fts()])));
    const user = userEvent.setup();
    render(<SearchPanel />);

    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "pricing tiers",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    // Frozen [n] passage number + FTS rank + chunk provenance.
    expect(await screen.findByText(/\[1\] · rank 0\.372 · chunk #2/)).toBeInTheDocument();
    expect(screen.getByText(/acme pricing/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /pricing snapshot/i }),
    ).toHaveAttribute("href", "/intel/documents/33333333-3333-4333-8333-333333333333");
    expect(screen.getByText(/enterprise tier is \$99/i)).toBeInTheDocument();
    expect(screen.getByText("Keyword rank")).toBeInTheDocument();

    const searchCall = fetchFn.mock.calls.find(([u]) =>
      String(u).startsWith("/api/intel/search"),
    );
    expect(String(searchCall![0])).toContain("q=pricing+tiers");
    // The query is written to the URL (shareable, q-param precedent).
    expect(nav.replace).toHaveBeenCalledWith("/intel/search?q=pricing+tiers");
  });

  test("keyword-only mode says plainly that no answer is coming", async () => {
    stubFetch(routes(keywordOnly([fts()])));
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);

    expect(await screen.findByText(KEYWORD_ONLY_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(SYNTHESIS_PENDING_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^answer$/i })).not.toBeInTheDocument();
  });

  test("auto-runs a query that arrives in the URL", async () => {
    stubFetch(routes(keywordOnly([fts()])));
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    expect(await screen.findByText(/rank 0\.372/)).toBeInTheDocument();
  });

  test("URL-driven initial search survives StrictMode's dev double-invoke", async () => {
    // Regression: the unmount cleanup used to bump the stale-response
    // generation without re-arming the initial-search guard, so StrictMode's
    // simulated remount skipped the search AND discarded the first run's
    // in-flight response — every dev open of a shared /intel/search?q= link
    // sat on "Searching…" forever.
    stubFetch(routes(keywordOnly([fts()], "alpha")));
    nav.params = new URLSearchParams("q=alpha");
    render(
      <StrictMode>
        <SearchPanel />
      </StrictMode>,
    );
    expect(await screen.findByText(/rank 0\.372/)).toBeInTheDocument();
  });

  test("zero matches renders an honest empty state naming chunking lag", async () => {
    stubFetch(routes(keywordOnly([])));
    nav.params = new URLSearchParams("q=unheard-of");
    render(<SearchPanel />);

    expect(await screen.findByText(/no matches/i)).toBeInTheDocument();
    expect(
      screen.getByText(/recent documents may still be chunking/i),
    ).toBeInTheDocument();
  });

  test("renders the not-provisioned state on a 503", async () => {
    stubFetch(
      routes({
        status: 503,
        body: { error: "intel-not-provisioned", message: "schema not applied" },
      }),
    );
    nav.params = new URLSearchParams("q=anything");
    render(<SearchPanel />);

    expect(await screen.findByText(NOT_PROVISIONED_TITLE)).toBeInTheDocument();
  });

  test("degraded search failures show the API error and keep the box usable", async () => {
    stubFetch(
      routes({ status: 500, body: { error: "search-failed", message: "fts blew up" } }),
    );
    nav.params = new URLSearchParams("q=anything");
    render(<SearchPanel />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/fts blew up/i);
    expect(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
    ).toBeInTheDocument();
  });

  test("a failed synthesis submission (degraded) keeps the results and says so", async () => {
    stubFetch(
      routes({
        query: "alpha",
        mode: "keyword-only",
        results: [fts()],
        answer: null,
        degraded: { reason: "synthesis-unavailable", detail: "gateway error" },
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);

    expect(await screen.findByText(SYNTHESIS_FAILED_TEXT)).toBeInTheDocument();
    expect(screen.getByText(/rank 0\.372/)).toBeInTheDocument();
  });
});

describe("SearchPanel — two-phase answer flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("pending → poll → completed: plain-text answer, rerank, client-side citations", async () => {
    const fetchFn = stubFetch(
      routes(agenticPending(threeRows(), "alpha"), {
        state: "completed",
        // Markdown + a URL on purpose: both must render as inert characters.
        answer: "**Beta** wins. See https://evil.example/prompt-injection [2]",
        citations: [2, 99],
        ranking: [2, 3, 99, 2],
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();

    // Phase 1: keyword results + honest synthesizing state.
    expect(screen.getByText(SYNTHESIS_PENDING_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Keyword rank")).toBeInTheDocument();
    expect(screen.getByText(/\[1\] · rank 0\.9/)).toBeInTheDocument();

    // Phase 2: the poll lands.
    await advance(ANSWER_POLL_INTERVAL_MS);
    expect(answerUrls(fetchFn)[0]).toBe(`/api/intel/search/answer/${TASK_ID}`);
    expect(screen.queryByText(SYNTHESIS_PENDING_TEXT)).not.toBeInTheDocument();

    // Plain text: the markdown stays literal, the URL is NOT a link.
    expect(
      screen.getByText(/\*\*Beta\*\* wins\. See https:\/\/evil\.example/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /evil\.example/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(ANSWER_DISCLAIMER_TEXT)).toBeInTheDocument();

    // Citations map client-side onto retrieved rows; 99 is out of range and
    // silently dropped, so exactly one chip renders, linking passage [2].
    expect(screen.getByRole("link", { name: /\[2\] doc two/i })).toHaveAttribute(
      "href",
      "/intel/documents/44444444-4444-4444-8444-444444444444",
    );
    expect(screen.queryByText(/\[99\]/)).not.toBeInTheDocument();

    // Rerank: display order becomes [2], [3], then unranked [1] at the tail
    // (99 and the duplicate 2 dropped) — passage numbers stay frozen.
    expect(screen.getByText("Ranked by Claude")).toBeInTheDocument();
    expect(screen.queryByText("Keyword rank")).not.toBeInTheDocument();
    const eyebrows = screen
      .getAllByText(/\[\d+\] · rank /)
      .map((el) => el.textContent);
    expect(eyebrows[0]).toContain("[2]");
    expect(eyebrows[1]).toContain("[3]");
    expect(eyebrows[2]).toContain("[1]");

    // Settled: no further polling.
    const settled = answerUrls(fetchFn).length;
    await advance(ANSWER_POLL_INTERVAL_MS * 3);
    expect(answerUrls(fetchFn).length).toBe(settled);
  });

  test("completed answer with an EMPTY ranking keeps the honest Keyword-rank badge", async () => {
    // The model may legally return no ranking (gateway coerces null/missing
    // to []): the display order stays pure keyword rank, so the badge must
    // not claim a rerank that never happened.
    stubFetch(
      routes(agenticPending(threeRows(), "alpha"), {
        state: "completed",
        answer: "The passages do not address this.",
        citations: [],
        ranking: [],
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();
    await advance(ANSWER_POLL_INTERVAL_MS);

    expect(screen.getByText(/passages do not address/i)).toBeInTheDocument();
    expect(screen.getByText("Keyword rank")).toBeInTheDocument();
    expect(screen.queryByText("Ranked by Claude")).not.toBeInTheDocument();
    // Order untouched: original keyword order.
    const eyebrows = screen
      .getAllByText(/\[\d+\] · rank /)
      .map((el) => el.textContent);
    expect(eyebrows[0]).toContain("[1]");
    expect(eyebrows[2]).toContain("[3]");
  });

  test("a malformed completed poll body cannot crash the panel (reads as pending)", async () => {
    stubFetch(
      routes(agenticPending([fts()], "alpha"), {
        status: 200,
        // Contract-breaking body: completed without a ranking array. Must be
        // normalized away (api.ts), never fed to the rerank memo.
        body: { state: "completed", answer: "x", citations: [1] },
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();
    await advance(ANSWER_POLL_INTERVAL_MS * 2);

    expect(screen.getByText(SYNTHESIS_PENDING_TEXT)).toBeInTheDocument();
    expect(screen.getByText(/rank 0\.372/)).toBeInTheDocument();
  });

  test("a failed answer shows honest copy and keeps the keyword results", async () => {
    stubFetch(
      routes(agenticPending([fts()], "alpha"), {
        state: "failed",
        reason: "synthesis-unparseable",
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();
    await advance(ANSWER_POLL_INTERVAL_MS);

    expect(screen.getByText(SYNTHESIS_FAILED_TEXT)).toBeInTheDocument();
    expect(screen.getByText(/rank 0\.372/)).toBeInTheDocument();
    expect(screen.getByText("Keyword rank")).toBeInTheDocument();
  });

  test("stops at the deadline with honest timeout copy (gateway has no failed state)", async () => {
    const fetchFn = stubFetch(routes(agenticPending([fts()], "alpha")));
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();

    await advance(ANSWER_POLL_DEADLINE_MS + ANSWER_POLL_INTERVAL_MS);
    expect(screen.getByText(SYNTHESIS_TIMEOUT_TEXT)).toBeInTheDocument();
    expect(screen.getByText(/rank 0\.372/)).toBeInTheDocument();

    // Polling actually stopped — no calls accumulate past the deadline.
    const atDeadline = answerUrls(fetchFn).length;
    await advance(ANSWER_POLL_INTERVAL_MS * 5);
    expect(answerUrls(fetchFn).length).toBe(atDeadline);
  });

  test("non-200 polls are retried until the deadline, not treated as failure", async () => {
    const fetchFn = stubFetch(
      routes(agenticPending([fts()], "alpha"), {
        status: 502,
        body: { error: "gateway-error" },
      }),
    );
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();

    await advance(ANSWER_POLL_INTERVAL_MS * 2);
    expect(answerUrls(fetchFn).length).toBe(2);
    expect(screen.getByText(SYNTHESIS_PENDING_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(SYNTHESIS_FAILED_TEXT)).not.toBeInTheDocument();
  });

  test("a new search supersedes the old poll (stale results can never land)", async () => {
    const fetchFn = stubFetch((url) => {
      if (url.startsWith("/api/intel/search/answer/")) {
        return {
          status: 200,
          body: { state: "completed", answer: "STALE ANSWER", citations: [], ranking: [] },
        };
      }
      if (url.startsWith("/api/intel/search")) {
        const q = new URL(url, "http://x").searchParams.get("q");
        return {
          status: 200,
          body: q === "alpha" ? agenticPending([fts()], "alpha") : keywordOnly([fts()], "beta"),
        };
      }
      return { status: 200, body: { sources: [], stats: [] } };
    });
    nav.params = new URLSearchParams("q=alpha");
    render(<SearchPanel />);
    await flush();
    expect(screen.getByText(SYNTHESIS_PENDING_TEXT)).toBeInTheDocument();

    // Supersede before the first poll tick fires.
    fireEvent.change(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      { target: { value: "beta" } },
    );
    fireEvent.submit(screen.getByRole("search"));
    await flush();

    await advance(ANSWER_POLL_INTERVAL_MS * 3);
    // The superseded task was never polled and its answer never rendered.
    expect(answerUrls(fetchFn).length).toBe(0);
    expect(screen.queryByText(/STALE ANSWER/)).not.toBeInTheDocument();
    expect(screen.getByText(KEYWORD_ONLY_TEXT)).toBeInTheDocument();
  });

  test("unmount stops polling", async () => {
    const fetchFn = stubFetch(routes(agenticPending([fts()], "alpha")));
    nav.params = new URLSearchParams("q=alpha");
    const { unmount } = render(<SearchPanel />);
    await flush();

    unmount();
    await advance(ANSWER_POLL_INTERVAL_MS * 3);
    expect(answerUrls(fetchFn).length).toBe(0);
  });
});

describe("SearchPanel — source filter", () => {
  const SOURCE = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Acme pricing",
    kind: "text",
    url: null,
    notes: null,
    created_by: null,
    created_at: "2026-08-08T12:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
  };

  test("drops a URL sourceId that no longer exists, says so, and re-runs unfiltered", async () => {
    nav.params = new URLSearchParams(
      "q=pricing&sourceId=99999999-9999-4999-8999-999999999999",
    );
    const fetchFn = stubFetch((url) =>
      url.startsWith("/api/intel/search")
        ? { status: 200, body: keywordOnly([fts()], "pricing") }
        : { status: 200, body: { sources: [SOURCE], stats: [] } },
    );
    render(<SearchPanel />);

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
        ? { status: 200, body: keywordOnly([]) }
        : { status: 500, body: { error: "boom" } },
    );
    const user = userEvent.setup();
    render(<SearchPanel />);

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
    const fetchFn = stubFetch((url) =>
      url.startsWith("/api/intel/search")
        ? { status: 200, body: keywordOnly([fts()], "pricing") }
        : { status: 200, body: { sources: [SOURCE], stats: [] } },
    );
    const user = userEvent.setup();
    render(<SearchPanel />);

    await user.selectOptions(
      await screen.findByRole("combobox", { name: /filter by source/i }),
      SOURCE.id,
    );
    await user.type(
      screen.getByRole("searchbox", { name: /search competitor intel/i }),
      "pricing",
    );
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    await screen.findByText(/rank 0\.372/);
    const searchCall = fetchFn.mock.calls.find(([u]) =>
      String(u).startsWith("/api/intel/search"),
    );
    expect(String(searchCall![0])).toContain(`sourceId=${SOURCE.id}`);
  });
});
