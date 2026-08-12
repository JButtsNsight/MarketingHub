import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SqlConsole, type HistoryDto, type SnippetDto } from "./SqlConsole";

const SNIPPET: SnippetDto = {
  id: "s1",
  name: "top tables",
  sql: "select * from pg_stat_user_tables",
  created_by: "amy@nsight.example",
  updated_at: "2026-08-06T12:00:00Z",
};

const HISTORY: HistoryDto = {
  id: "h1",
  sql: "select count(*) from marketinghub.templates",
  ran_by: "amy@nsight.example",
  ran_at: "2026-08-06T11:00:00Z",
  duration_ms: 20,
  row_count: 1,
  error: null,
};

function mockFetchRoutes(
  postResponses: Array<{ status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let postIndex = 0;
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (url === "/api/console/sql" && method === "POST") {
      const next = postResponses[Math.min(postIndex++, postResponses.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(next.body), { status: next.status }),
      );
    }
    if (url === "/api/console/sql" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ history: [HISTORY] }), { status: 200 }),
      );
    }
    if (url === "/api/console/snippets" && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ snippet: { ...SNIPPET, id: "s2", name: "saved" } }),
          { status: 201 },
        ),
      );
    }
    if (url === "/api/console/assistant" && method === "POST") {
      // Completed-cache shape: the answer arrives with the POST (no polling).
      return Promise.resolve(
        new Response(
          JSON.stringify({
            answer: {
              state: "completed",
              explanation: "Counts templates.",
              sql: "select count(*) from marketinghub.templates;",
            },
            degraded: null,
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SqlConsole", () => {
  test("runs a query and renders the results grid with count + duration", async () => {
    const { calls } = mockFetchRoutes([
      {
        status: 200,
        body: {
          rows: [{ ok: 1, who: "supabase_admin" }],
          rowCount: 1,
          truncated: false,
          durationMs: 17,
          classification: "read",
        },
      },
    ]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    await user.click(screen.getByRole("button", { name: /Run \(/ }));

    await waitFor(() => expect(screen.getByText("supabase_admin")).toBeInTheDocument());
    expect(screen.getByText(/1 row · 17 ms/)).toBeInTheDocument();
    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(post!.init!.body as string)).toMatchObject({
      sql: expect.stringContaining("select"),
    });
  });

  test("write handshake: 409 shows Run write; confirming re-posts with confirmWrite", async () => {
    const { calls } = mockFetchRoutes([
      { status: 409, body: { requiresConfirmation: true, classification: "write" } },
      {
        status: 200,
        body: { rows: [], rowCount: 0, truncated: false, durationMs: 3, classification: "write" },
      },
    ]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    await user.click(screen.getByRole("button", { name: /Run \(/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/modifies the database/i),
    );

    await user.click(screen.getByRole("button", { name: "Run write" }));

    await waitFor(() => {
      const posts = calls.filter((c) => c.init?.method === "POST");
      expect(posts).toHaveLength(2);
      expect(JSON.parse(posts[1].init!.body as string)).toMatchObject({
        confirmWrite: true,
      });
    });
    expect(screen.getByText(/Success — no rows/)).toBeInTheDocument();
  });

  test("a 400 surfaces the real Postgres error", async () => {
    mockFetchRoutes([
      { status: 400, body: { error: 'relation "nope" does not exist' } },
    ]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    await user.click(screen.getByRole("button", { name: /Run \(/ }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/does not exist/),
    );
  });

  test("snippets load into the editor; history entries render with outcomes", async () => {
    mockFetchRoutes([]);
    const user = userEvent.setup();
    render(
      <SqlConsole initialSnippets={[SNIPPET]} initialHistory={[HISTORY]} />,
    );

    expect(screen.getByText(/2026-08-06 11:00 UTC/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "top tables" }));
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    await waitFor(() =>
      expect(editor.textContent).toContain("pg_stat_user_tables"),
    );
  });

  test("assistant proposal REPLACES the editor document and never auto-runs", async () => {
    const { calls } = mockFetchRoutes([]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    // The editor starts with the default draft — the proposal must replace
    // it wholesale (the snippet/history idiom), not append to it.
    const editor = screen.getByRole("textbox", { name: "SQL editor" });
    await waitFor(() => expect(editor.textContent).toContain("n_live_tup"));

    await user.type(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
      "count templates",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await user.click(
      await screen.findByRole("button", { name: "Replace editor" }),
    );
    await waitFor(() =>
      expect(editor.textContent).toContain(
        "select count(*) from marketinghub.templates;",
      ),
    );
    expect(editor.textContent).not.toContain("n_live_tup");
    // Insert-not-run: nothing ever left for the sql run route.
    expect(
      calls.filter((c) => c.url === "/api/console/sql" && c.init?.method === "POST"),
    ).toHaveLength(0);
  });

  test("an armed write confirm never carries over to a replaced document", async () => {
    // First run 409s (write) and arms "Run write"; the follow-up run of the
    // REPLACED statement must re-enter classify (no confirmWrite in the body).
    const { calls } = mockFetchRoutes([
      { status: 409, body: { requiresConfirmation: true, classification: "write" } },
      {
        status: 200,
        body: { rows: [], rowCount: 0, truncated: false, durationMs: 2, classification: "read" },
      },
    ]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    await user.click(screen.getByRole("button", { name: /Run \(/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run write" })).toBeInTheDocument(),
    );

    await user.type(
      screen.getByRole("searchbox", { name: /ask the assistant/i }),
      "clean up rows",
    );
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await user.click(
      await screen.findByRole("button", { name: "Replace editor" }),
    );

    // Disarmed: the confirm granted for the PREVIOUS statement is gone and
    // the plain Run is back.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Run write" })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /Run \(/ }));

    await waitFor(() => {
      const posts = calls.filter(
        (c) => c.url === "/api/console/sql" && c.init?.method === "POST",
      );
      expect(posts).toHaveLength(2);
      const body = JSON.parse(posts[1].init!.body as string) as Record<string, unknown>;
      expect(body.confirmWrite).toBeUndefined();
      expect(body.sql).toContain("select count(*) from marketinghub.templates;");
    });
  });

  test("saving a snippet POSTs the current document and adds it to the rail", async () => {
    const { calls } = mockFetchRoutes([]);
    const user = userEvent.setup();
    render(<SqlConsole initialSnippets={[]} initialHistory={[]} />);

    await user.click(screen.getByRole("button", { name: "Save snippet" }));
    await user.type(screen.getByLabelText("Snippet name"), "saved");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === "/api/console/snippets" && c.init?.method === "POST",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(post!.init!.body as string)).toMatchObject({
        name: "saved",
      });
      expect(screen.getByRole("button", { name: "saved" })).toBeInTheDocument();
    });
  });
});
