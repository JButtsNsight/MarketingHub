import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourcesManager } from "./SourcesManager";
import { NOT_PROVISIONED_TITLE } from "./status";
import type { IntelSourceSummary } from "./types";

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

type SourceRow = Omit<IntelSourceSummary, "document_count" | "chunk_count">;

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Acme pricing",
    kind: "text",
    url: null,
    notes: null,
    created_by: null,
    created_at: "2026-08-08T12:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
    ...overrides,
  };
}

/** The real route envelope: sources + aggregate stats (repo SourceStats). */
function sourcesBody(rows: SourceRow[] = [source()]) {
  return {
    sources: rows,
    stats: rows.map((row) => ({
      source_id: row.id,
      document_count: 3,
      chunk_count: 42,
      embedded_document_count: 3,
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SourcesManager", () => {
  test("renders sources with kind, doc/chunk counts, and a detail link", async () => {
    stubFetch(() => ({ status: 200, body: sourcesBody() }));
    render(<SourcesManager />);

    const link = await screen.findByRole("link", { name: /acme pricing/i });
    expect(link).toHaveAttribute(
      "href",
      "/intel/sources/11111111-1111-4111-8111-111111111111",
    );
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  test("shows an honest dash when the response carries no stats", async () => {
    stubFetch(() => ({
      status: 200,
      body: { sources: [source()] },
    }));
    render(<SourcesManager />);
    await screen.findByRole("link", { name: /acme pricing/i });
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  test("renders the empty state when there are no sources", async () => {
    stubFetch(() => ({ status: 200, body: sourcesBody([]) }));
    render(<SourcesManager />);
    expect(await screen.findByText(/no sources yet/i)).toBeInTheDocument();
  });

  test("renders the not-provisioned state on the route's honest 503", async () => {
    stubFetch(() => ({
      status: 503,
      body: {
        error: "intel-not-provisioned",
        message: "[intel] list-sources failed: competitor_intel schema is not applied",
      },
    }));
    render(<SourcesManager />);
    expect(await screen.findByText(NOT_PROVISIONED_TITLE)).toBeInTheDocument();
  });

  test("renders a degraded state with the API's error and a retry", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { error: "kaboom" } }
        : { status: 200, body: sourcesBody() };
    });
    const user = userEvent.setup();
    render(<SourcesManager />);

    expect(await screen.findByRole("alert")).toHaveTextContent("kaboom");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("link", { name: /acme pricing/i })).toBeInTheDocument();
  });

  test("creates a source via POST /api/intel/sources", async () => {
    const fetchFn = stubFetch((url, init) => {
      if ((init?.method ?? "GET") === "POST") return { status: 201, body: { id: "x" } };
      return { status: 200, body: sourcesBody([]) };
    });
    const user = userEvent.setup();
    render(<SourcesManager />);

    await user.click(await screen.findByRole("button", { name: /new source/i }));
    // The URL-fetch deferral is labeled plainly on the form.
    expect(screen.getByText(/URL fetch: follow-up pending SSRF guardrails/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/name/i), "Acme changelog");
    await user.click(screen.getByRole("button", { name: /create source/i }));

    const post = fetchFn.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeTruthy();
    expect(String(post![0])).toBe("/api/intel/sources");
    expect(JSON.parse(post![1]?.body as string)).toMatchObject({
      name: "Acme changelog",
      kind: "text",
    });
  });

  test("blocks an invalid create client-side (no POST fired)", async () => {
    const fetchFn = stubFetch(() => ({ status: 200, body: sourcesBody([]) }));
    const user = userEvent.setup();
    render(<SourcesManager />);

    await user.click(await screen.findByRole("button", { name: /new source/i }));
    await user.click(screen.getByRole("button", { name: /create source/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/name is required/i);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  test("edits a source via PATCH", async () => {
    const fetchFn = stubFetch((url, init) => {
      if (init?.method === "PATCH") return { status: 200, body: { source: source() } };
      return { status: 200, body: sourcesBody() };
    });
    const user = userEvent.setup();
    render(<SourcesManager />);

    await user.click(await screen.findByRole("button", { name: /edit/i }));
    const name = screen.getByLabelText(/name/i);
    await user.clear(name);
    await user.type(name, "Acme pricing v2");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const patch = fetchFn.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(String(patch![0])).toBe(
      "/api/intel/sources/11111111-1111-4111-8111-111111111111",
    );
    expect(JSON.parse(patch![1]?.body as string)).toMatchObject({
      name: "Acme pricing v2",
    });
  });

  test("delete is a two-step confirm before the DELETE call", async () => {
    const fetchFn = stubFetch((url, init) => {
      if (init?.method === "DELETE") return { status: 204, body: null };
      return { status: 200, body: sourcesBody() };
    });
    const user = userEvent.setup();
    render(<SourcesManager />);

    const del = await screen.findByRole("button", { name: /^delete$/i });
    await user.click(del);
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: /really delete/i }));
    expect(
      fetchFn.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
  });
});
