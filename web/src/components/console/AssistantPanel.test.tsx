import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ASSISTANT_POLL_DEADLINE_MS,
  ASSISTANT_POLL_INTERVAL_MS,
} from "./assistantApi";
import {
  AssistantPanel,
  ASSISTANT_ERROR_TEXT,
  ASSISTANT_FAILED_TEXT,
  ASSISTANT_PENDING_TEXT,
  ASSISTANT_TIMEOUT_TEXT,
  ASSISTANT_UNAVAILABLE_TEXT,
} from "./AssistantPanel";

const TASK_ID = "mh-sqlast-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function pendingAsk() {
  return { answer: { state: "pending", taskId: TASK_ID }, degraded: null };
}

function completedAnswer(sql: string | null = "select count(*) from marketinghub.templates;") {
  return {
    state: "completed",
    // Markdown + a URL on purpose: both must render as inert characters.
    explanation: "**Counts** templates. See https://evil.example/injection",
    sql,
  };
}

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

/** Routes the ask POST + answer poll (real envelopes unless {status,body}). */
function routes(
  ask: unknown,
  answer: unknown = { state: "pending" },
): Handler {
  const wrap = (value: unknown) =>
    value && typeof value === "object" && "status" in value && "body" in value
      ? (value as { status: number; body: unknown })
      : { status: 200, body: value };
  return (url) => {
    if (url.startsWith("/api/console/assistant/answer/")) return wrap(answer);
    if (url === "/api/console/assistant") return wrap(ask);
    return { status: 404, body: { error: "unexpected-url" } };
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

function pollUrls(fn: ReturnType<typeof stubFetch>): string[] {
  return fn.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.startsWith("/api/console/assistant/answer/"));
}

/** Submit a question with fireEvent (fake-timer safe). */
function ask(question: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: /ask the assistant/i }), {
    target: { value: question },
  });
  fireEvent.submit(screen.getByRole("search"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AssistantPanel — ask phase", () => {
  test("starts idle: input + disabled Ask, no notes, no fetches", () => {
    const fetchFn = stubFetch(routes(pendingAsk()));
    render(<AssistantPanel onInsert={vi.fn()} />);

    expect(
      screen.getByPlaceholderText("Ask about this database…"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
    expect(screen.queryByText(ASSISTANT_PENDING_TEXT)).not.toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("degraded (env absent) → honest one-liner, input stays usable", async () => {
    stubFetch(
      routes({ answer: null, degraded: { reason: "assistant-unavailable" } }),
    );
    const user = userEvent.setup();
    render(<AssistantPanel onInsert={vi.fn()} />);

    await user.type(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
      "how many templates?",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText(ASSISTANT_UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
    ).toBeEnabled();
  });

  test("server cache hit: POST returns completed → renders with zero polls", async () => {
    const fetchFn = stubFetch(
      routes({ answer: completedAnswer(), degraded: null }),
    );
    const user = userEvent.setup();
    render(<AssistantPanel onInsert={vi.fn()} />);

    await user.type(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
      "count templates",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();
    expect(pollUrls(fetchFn).length).toBe(0);
  });

  test("a non-200 ask surfaces the terse error copy", async () => {
    stubFetch(routes({ status: 502, body: { error: "gateway-error" } }));
    const user = userEvent.setup();
    render(<AssistantPanel onInsert={vi.fn()} />);

    await user.type(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
      "anything",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_ERROR_TEXT);
  });

  test("a new question replaces the previous answer (single Q→A)", async () => {
    let calls = 0;
    stubFetch((url) => {
      if (url !== "/api/console/assistant") return { status: 404, body: {} };
      calls += 1;
      return {
        status: 200,
        body: {
          answer:
            calls === 1
              ? completedAnswer()
              : { state: "completed", explanation: "Second answer.", sql: null },
          degraded: null,
        },
      };
    });
    const user = userEvent.setup();
    render(<AssistantPanel onInsert={vi.fn()} />);

    const input = screen.getByRole("searchbox", { name: /ask the assistant/i });
    await user.type(input, "first");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "second");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Second answer.")).toBeInTheDocument();
    expect(screen.queryByText(/\*\*Counts\*\* templates/)).not.toBeInTheDocument();
  });
});

describe("AssistantPanel — poll flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("pending → poll → completed: plain-text explanation, SQL block, insert-not-run", async () => {
    const onInsert = vi.fn();
    const fetchFn = stubFetch(routes(pendingAsk(), completedAnswer()));
    render(<AssistantPanel onInsert={onInsert} />);

    ask("how many templates?");
    await flush();

    // Pending state: honest note, but the input + Ask STAY usable — a new
    // question supersedes the in-flight poll (never a 90 s lockout).
    expect(screen.getByText(ASSISTANT_PENDING_TEXT)).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();

    await advance(ASSISTANT_POLL_INTERVAL_MS);
    expect(pollUrls(fetchFn)[0]).toBe(`/api/console/assistant/answer/${TASK_ID}`);
    expect(screen.queryByText(ASSISTANT_PENDING_TEXT)).not.toBeInTheDocument();

    // Plain text: the markdown stays literal, the URL is NOT a link.
    expect(screen.getByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /evil\.example/i }),
    ).not.toBeInTheDocument();

    // The proposal renders in a monospace block with ONE action.
    expect(
      screen.getByText(/select count\(\*\) from marketinghub\.templates;/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace editor" }));
    expect(onInsert).toHaveBeenCalledWith(
      "select count(*) from marketinghub.templates;",
    );

    // Nothing auto-executes: no call ever leaves for the sql run route.
    expect(
      fetchFn.mock.calls.map(([u]) => String(u)).filter((u) => u === "/api/console/sql"),
    ).toHaveLength(0);

    // Settled: no further polling.
    const settled = pollUrls(fetchFn).length;
    await advance(ASSISTANT_POLL_INTERVAL_MS * 3);
    expect(pollUrls(fetchFn).length).toBe(settled);
  });

  test("sql:null → explanation only, no insert action", async () => {
    stubFetch(routes(pendingAsk(), completedAnswer(null)));
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("what is this database for?");
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS);

    expect(screen.getByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replace editor" }),
    ).not.toBeInTheDocument();
  });

  test("blank sql coerces to null client-side (no insert action)", async () => {
    stubFetch(routes(pendingAsk(), completedAnswer("   ")));
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS);

    expect(screen.getByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Replace editor" }),
    ).not.toBeInTheDocument();
  });

  test("a failed poll shows the terse failure copy and re-enables the input", async () => {
    stubFetch(
      routes(pendingAsk(), { state: "failed", reason: "assistant-unparseable" }),
    );
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS);

    expect(screen.getByText(ASSISTANT_FAILED_TEXT)).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
    ).toBeEnabled();
  });

  test("a failed poll with gateway-not-configured maps to the unavailable one-liner", async () => {
    stubFetch(
      routes(pendingAsk(), { state: "failed", reason: "gateway-not-configured" }),
    );
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS);

    expect(screen.getByText(ASSISTANT_UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(ASSISTANT_FAILED_TEXT)).not.toBeInTheDocument();
  });

  test("a malformed completed poll body reads as pending (never crashes)", async () => {
    stubFetch(
      routes(pendingAsk(), {
        status: 200,
        // Contract-breaking body: completed without an explanation. Must be
        // normalized away (assistantApi.ts), never dereferenced.
        body: { state: "completed", sql: "select 1;" },
      }),
    );
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS * 2);

    expect(screen.getByText(ASSISTANT_PENDING_TEXT)).toBeInTheDocument();
  });

  test("non-200 polls are retried until the deadline, then honest timeout; polling stops", async () => {
    const fetchFn = stubFetch(
      routes(pendingAsk(), { status: 502, body: { error: "gateway-error" } }),
    );
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();

    await advance(ASSISTANT_POLL_INTERVAL_MS * 2);
    expect(pollUrls(fetchFn).length).toBe(2);
    expect(screen.getByText(ASSISTANT_PENDING_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(ASSISTANT_FAILED_TEXT)).not.toBeInTheDocument();

    await advance(ASSISTANT_POLL_DEADLINE_MS);
    expect(screen.getByText(ASSISTANT_TIMEOUT_TEXT)).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
    ).toBeEnabled();

    // Polling actually stopped — no calls accumulate past the deadline.
    const atDeadline = pollUrls(fetchFn).length;
    await advance(ASSISTANT_POLL_INTERVAL_MS * 5);
    expect(pollUrls(fetchFn).length).toBe(atDeadline);
  });

  test("a new question supersedes an in-flight poll (no 90 s lockout)", async () => {
    // Ask #1 pends forever (silently dead task); ask #2 completes at once.
    let asks = 0;
    const fetchFn = stubFetch((url) => {
      if (url.startsWith("/api/console/assistant/answer/")) {
        return { status: 200, body: { state: "pending" } };
      }
      if (url === "/api/console/assistant") {
        asks += 1;
        return asks === 1
          ? { status: 200, body: pendingAsk() }
          : { status: 200, body: { answer: completedAnswer(), degraded: null } };
      }
      return { status: 404, body: { error: "unexpected-url" } };
    });
    render(<AssistantPanel onInsert={vi.fn()} />);

    ask("how many templatse?"); // typo the user notices immediately
    await flush();
    await advance(ASSISTANT_POLL_INTERVAL_MS);
    expect(screen.getByText(ASSISTANT_PENDING_TEXT)).toBeInTheDocument();

    // Resubmit WITHOUT waiting out the deadline: the answer lands right away…
    ask("how many templates?");
    await flush();
    expect(screen.getByText(/\*\*Counts\*\* templates/)).toBeInTheDocument();

    // …and the superseded task's poll chain is dead (no calls accumulate).
    const settled = pollUrls(fetchFn).length;
    await advance(ASSISTANT_POLL_INTERVAL_MS * 3);
    expect(pollUrls(fetchFn).length).toBe(settled);
  });

  test("unmount stops polling", async () => {
    const fetchFn = stubFetch(routes(pendingAsk()));
    const { unmount } = render(<AssistantPanel onInsert={vi.fn()} />);

    ask("q");
    await flush();

    unmount();
    await advance(ASSISTANT_POLL_INTERVAL_MS * 3);
    expect(pollUrls(fetchFn).length).toBe(0);
  });
});
