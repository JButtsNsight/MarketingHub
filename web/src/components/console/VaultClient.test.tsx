import { afterEach, describe, expect, test, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VaultClient } from "./VaultClient";
import type { VaultSecretMeta } from "@/lib/console/vault";

const PLAINTEXT = "sk_live_SENTINEL_hunter2";

const SECRETS: VaultSecretMeta[] = [
  {
    id: "11111111-2222-3333-4444-555555555555",
    name: "stripe-api-key",
    description: "billing",
    createdAt: "2026-08-08 02:00:00+00",
    updatedAt: "2026-08-08 02:00:00+00",
  },
  {
    id: "99999999-8888-7777-6666-555555555555",
    name: null,
    description: "",
    createdAt: "2026-08-07 02:00:00+00",
    updatedAt: "2026-08-07 02:00:00+00",
  },
];

function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ secrets: SECRETS }), { status: 200 }),
      );
    }
    if (url.endsWith("/reveal")) {
      return Promise.resolve(
        new Response(JSON.stringify({ value: PLAINTEXT }), { status: 200 }),
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
  vi.useRealTimers();
});

describe("VaultClient", () => {
  test("lists metadata with every value masked — no plaintext, no fetch on mount", () => {
    const { calls } = mockFetchRoutes();
    render(<VaultClient initialSecrets={SECRETS} />);

    expect(screen.getByText("stripe-api-key")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
    // The unnamed secret shows its id prefix, flagged as unnamed.
    expect(screen.getByText(/99999999…/)).toBeInTheDocument();
    // Both value cells render the mask; nothing looks like a value.
    expect(screen.getAllByLabelText("value hidden")).toHaveLength(2);
    expect(document.body.textContent).not.toContain(PLAINTEXT);
    // Rendering the list is fetch-free — metadata came from the server page.
    expect(calls).toHaveLength(0);
  });

  test("reveal = per-secret warn confirm, then POST; cancel sends nothing", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    const modal = screen.getByRole("alertdialog");
    expect(modal).toHaveTextContent(/Reveal "stripe-api-key"\?/);
    expect(modal).toHaveTextContent(/audit log/);
    await user.click(within(modal).getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);
    expect(document.body.textContent).not.toContain(PLAINTEXT);

    await user.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reveal secret",
      }),
    );

    await screen.findByText(PLAINTEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `/api/console/vault/${SECRETS[0].id}/reveal`,
    );
    expect(calls[0].init?.method).toBe("POST");
    // POST-only and value-free traffic: no value ever rides a URL.
    expect(calls[0].url).not.toContain(PLAINTEXT);
  });

  test("Hide masks the value again; nothing touches the clipboard", async () => {
    mockFetchRoutes();
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reveal secret",
      }),
    );
    await screen.findByText(PLAINTEXT);

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.body.textContent).not.toContain(PLAINTEXT);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("a revealed value auto-masks after the TTL", async () => {
    mockFetchRoutes();
    // fireEvent (synchronous) rather than userEvent here: userEvent's own
    // waits deadlock against fake timers, and this test owns the clock.
    vi.useFakeTimers();
    render(<VaultClient initialSecrets={SECRETS} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reveal secret",
      }),
    );
    // Drain the fetch/json microtasks (no timers involved).
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(PLAINTEXT)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(document.body.textContent).not.toContain(PLAINTEXT);
  });

  test("unmount clears the transient reveal state", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    const { unmount } = render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reveal secret",
      }),
    );
    await screen.findByText(PLAINTEXT);

    unmount();
    expect(document.body.textContent).not.toContain(PLAINTEXT);
  });

  test("Delete refuses when the typed secret name does not match", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[0]);
    const modal = screen.getByRole("alertdialog");
    await user.type(within(modal).getByLabelText(/to confirm/), "stripe-api-ke");
    await user.click(
      within(modal).getByRole("button", { name: "Delete secret" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/did not match/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  test("Delete with the exact typed name DELETEs with the confirm echo, then refreshes", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[0]);
    const modal = screen.getByRole("alertdialog");
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      "stripe-api-key",
    );
    await user.click(
      within(modal).getByRole("button", { name: "Delete secret" }),
    );

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toBe(`/api/console/vault/${SECRETS[0].id}`);
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        confirm: "stripe-api-key",
      });
    });
    // The list re-fetches after the delete.
    await waitFor(() =>
      expect(calls.some((c) => (c.init?.method ?? "GET") === "GET")).toBe(true),
    );
  });

  test("an unnamed secret confirms deletion by its id", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[1]);
    const modal = screen.getByRole("alertdialog");
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      SECRETS[1].id,
    );
    await user.click(
      within(modal).getByRole("button", { name: "Delete secret" }),
    );

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toBe(`/api/console/vault/${SECRETS[1].id}`);
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        confirm: SECRETS[1].id,
      });
    });
  });

  test("a name with edge whitespace is deletable — the typed confirm is NOT trimmed", async () => {
    // Secrets created outside the console (SQL editor, vault.create_secret)
    // can carry leading/trailing whitespace; the server compares the confirm
    // echo exactly, so the client must send the typed value verbatim.
    const whitespaceSecret: VaultSecretMeta = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: " api key ",
      description: "",
      createdAt: "2026-08-08 02:00:00+00",
      updatedAt: "2026-08-08 02:00:00+00",
    };
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={[whitespaceSecret]} />);

    await user.click(screen.getByRole("button", { name: "Delete…" }));
    const modal = screen.getByRole("alertdialog");
    const input = within(modal).getByLabelText(/to confirm/);
    // userEvent.type collapses edge whitespace idiosyncratically; set the
    // exact value the way a paste would land it.
    fireEvent.change(input, { target: { value: " api key " } });
    await user.click(
      within(modal).getByRole("button", { name: "Delete secret" }),
    );

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toBe(`/api/console/vault/${whitespaceSecret.id}`);
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        confirm: " api key ",
      });
    });
  });

  test("New secret dialog POSTs name/description/value in the JSON body", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getByRole("button", { name: "New secret" }));
    const valueInput = screen.getByLabelText("Value");
    // The value is masked while typing and kept away from autofill.
    expect(valueInput).toHaveAttribute("type", "password");
    expect(valueInput).toHaveAttribute("autocomplete", "new-password");

    await user.type(screen.getByLabelText("Name"), "new-key");
    await user.type(screen.getByLabelText("Description"), "for tests");
    await user.type(valueInput, PLAINTEXT);
    await user.click(screen.getByRole("button", { name: "Create secret" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      expect(post!.url).toBe("/api/console/vault");
      expect(JSON.parse(post!.init!.body as string)).toEqual({
        name: "new-key",
        description: "for tests",
        value: PLAINTEXT,
      });
    });
    // Dialog closed after save; the value input (and its state) is gone.
    await waitFor(() =>
      expect(screen.queryByLabelText("Value")).not.toBeInTheDocument(),
    );
  });

  test("create dialog refuses an empty value without sending anything", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getByRole("button", { name: "New secret" }));
    await user.type(screen.getByLabelText("Name"), "new-key");
    await user.click(screen.getByRole("button", { name: "Create secret" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/Value is required/);
    expect(calls).toHaveLength(0);
  });

  test("Edit prefills name/description but NEVER the value, and PATCHes", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByLabelText("Name")).toHaveValue("stripe-api-key");
    expect(screen.getByLabelText("Description")).toHaveValue("billing");
    const valueInput = screen.getByLabelText("Value");
    expect(valueInput).toHaveValue("");
    expect(screen.getByRole("dialog")).toHaveTextContent(/REPLACES/);

    await user.type(valueInput, "rotated-value");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(patch!.url).toBe(`/api/console/vault/${SECRETS[0].id}`);
      expect(JSON.parse(patch!.init!.body as string)).toEqual({
        name: "stripe-api-key",
        description: "billing",
        value: "rotated-value",
      });
    });
  });

  test("surfaces the route's error when a reveal is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "reveal failed" }), {
            status: 400,
          }),
        ),
      ),
    );
    const user = userEvent.setup();
    render(<VaultClient initialSecrets={SECRETS} />);

    await user.click(screen.getAllByRole("button", { name: "Reveal…" })[0]);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Reveal secret",
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("reveal failed"),
    );
    expect(document.body.textContent).not.toContain(PLAINTEXT);
  });
});
