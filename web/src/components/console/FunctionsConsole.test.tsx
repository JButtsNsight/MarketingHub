import { afterEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FunctionsConsole, type EdgeFunctionRow } from "./FunctionsConsole";

const HELLO: EdgeFunctionRow = {
  name: "hello",
  version: "1",
  updated_at: "2026-08-08T12:00:00Z",
  deployed_at: "2026-08-08T12:05:00Z",
  notes: null,
  source: 'serve(() => new Response("Hello from the registry"))',
};

const EMBED: EdgeFunctionRow = {
  name: "embed",
  version: "0",
  updated_at: "2026-08-07T09:30:00Z",
  deployed_at: null,
  notes: "W8 scaffold — placeholder",
  source: "export default async () => ({ vector: [] });",
};

function mockInvokeFetch(
  respond: () => Promise<Response> = async () =>
    new Response(
      JSON.stringify({
        status: 200,
        durationMs: 42,
        contentType: "application/json",
        body: '{"message":"Hello!"}',
        truncated: false,
      }),
      { status: 200 },
    ),
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FunctionsConsole — registry list", () => {
  test("renders name / version / updated / deployed per registry row", () => {
    mockInvokeFetch();
    render(<FunctionsConsole initialFunctions={[HELLO, EMBED]} />);

    // role=cell scopes to the table — the invoke <option>s reuse the names.
    expect(screen.getByRole("cell", { name: "hello" })).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("2026-08-08 12:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("2026-08-08 12:05 UTC")).toBeInTheDocument();

    // Registered but never shipped to the host: an honest badge, not a blank.
    expect(screen.getByRole("cell", { name: "embed" })).toBeInTheDocument();
    expect(screen.getByText("not deployed")).toBeInTheDocument();
  });

  test("empty registry renders the honest not-applied-yet state", () => {
    mockInvokeFetch();
    render(<FunctionsConsole initialFunctions={[]} />);
    expect(
      screen.getByText(/No edge functions registered yet/),
    ).toBeInTheDocument();
    // Nothing to invoke either.
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  });

  test("logs panel is the Wave-6 placeholder — no controls, no fake data", () => {
    mockInvokeFetch();
    render(<FunctionsConsole initialFunctions={[HELLO]} />);
    expect(
      screen.getByText(
        /Logs are edge-runtime container stdout; surfacing lands with Logflare \(Wave 6\)/,
      ),
    ).toBeInTheDocument();
  });
});

describe("FunctionsConsole — source viewer", () => {
  test("shows the registry source read-only without any fetch", async () => {
    const { fn } = mockInvokeFetch();
    const user = userEvent.setup();
    render(<FunctionsConsole initialFunctions={[HELLO, EMBED]} />);

    await user.click(screen.getAllByRole("button", { name: "Source" })[0]);
    expect(
      screen.getByText('serve(() => new Response("Hello from the registry"))'),
    ).toBeInTheDocument();
    // Source comes from the preloaded registry row — the app can't read the
    // edge-runtime volume, so there is nothing to fetch.
    expect(fn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Hide source" }));
    expect(
      screen.queryByText('serve(() => new Response("Hello from the registry"))'),
    ).not.toBeInTheDocument();
  });
});

describe("FunctionsConsole — invoke tester", () => {
  test("sends {name, method, body} to the server proxy and renders the result panel", async () => {
    const { calls } = mockInvokeFetch();
    const user = userEvent.setup();
    render(<FunctionsConsole initialFunctions={[HELLO, EMBED]} />);

    fireEvent.change(screen.getByLabelText("JSON body"), {
      target: { value: '{"n":"w"}' },
    });
    await user.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0].url).toBe("/api/console/functions/invoke");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      name: "hello",
      method: "POST",
      body: '{"n":"w"}',
    });

    // Result panel: status / duration / content type / body.
    expect(await screen.findByText("HTTP 200")).toBeInTheDocument();
    expect(screen.getByText("42ms")).toBeInTheDocument();
    expect(screen.getByText("application/json")).toBeInTheDocument();
    expect(screen.getByText('{"message":"Hello!"}')).toBeInTheDocument();
  });

  test("invalid JSON body blocks the send — parse error shown, no fetch", async () => {
    const { fn } = mockInvokeFetch();
    render(<FunctionsConsole initialFunctions={[HELLO]} />);

    fireEvent.change(screen.getByLabelText("JSON body"), {
      target: { value: "{nope" },
    });

    expect(
      await screen.findByText(/Body is not valid JSON/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(fn).not.toHaveBeenCalled();
  });

  test("a 502 from the proxy renders the honest edge-runtime-down state", async () => {
    mockInvokeFetch(async () =>
      new Response(
        JSON.stringify({ reason: "Edge runtime unreachable: fetch failed" }),
        { status: 502 },
      ),
    );
    const user = userEvent.setup();
    render(<FunctionsConsole initialFunctions={[HELLO]} />);

    await user.click(screen.getByRole("button", { name: "Send request" }));

    const alert = await screen.findByText(/Edge runtime down/);
    expect(alert).toHaveTextContent(/restart-loop/);
  });

  test("a 503 from the proxy renders the invoke-unavailable state", async () => {
    mockInvokeFetch(async () =>
      new Response(
        JSON.stringify({ reason: "SUPABASE_URL is unset — edge-function invocation is not configured on this deployment." }),
        { status: 503 },
      ),
    );
    const user = userEvent.setup();
    render(<FunctionsConsole initialFunctions={[HELLO]} />);

    await user.click(screen.getByRole("button", { name: "Send request" }));

    const alert = await screen.findByText(/Invoke unavailable/);
    expect(alert).toHaveTextContent(/SUPABASE_URL/);
  });

  test("switching to GET hides the body editor and posts without a body key", async () => {
    const { calls } = mockInvokeFetch();
    const user = userEvent.setup();
    render(<FunctionsConsole initialFunctions={[HELLO]} />);

    await user.selectOptions(screen.getByLabelText("Method"), "GET");
    expect(screen.queryByLabelText("JSON body")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      name: "hello",
      method: "GET",
    });
  });
});
