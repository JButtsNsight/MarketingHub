import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  WebhooksClient,
  type TableRefDto,
  type WebhookDto,
} from "./WebhooksClient";

const HOOK: WebhookDto = {
  schema: "public",
  table: "notes",
  name: "notes_webhook",
  events: ["insert", "delete"],
  enabled: true,
  url: "https://example.com/hook",
  method: "POST",
  definition: "CREATE TRIGGER notes_webhook ...",
};

const TABLES: TableRefDto[] = [
  { schema: "marketinghub", name: "templates" },
  { schema: "public", name: "notes" },
];

/** Route-aware fetch mock: GET refresh, POST create, DELETE drop. */
function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ webhooks: [HOOK], availableTables: TABLES, ready: true }), {
          status: 200,
        }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ created: "new_hook" }), { status: 201 }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ dropped: "notes_webhook" }), { status: 200 }),
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

describe("WebhooksClient", () => {
  test("renders webhooks and shows no confirm modal on browse", () => {
    mockFetchRoutes();
    render(
      <WebhooksClient initialWebhooks={[HOOK]} availableTables={TABLES} ready />,
    );

    expect(screen.getByText("notes_webhook")).toBeInTheDocument();
    expect(screen.getByText("public.notes")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/hook")).toBeInTheDocument();
    // Just browsing: no interrupting modal.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("dropping pops the confirm modal and only DELETEs on confirm", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(
      <WebhooksClient initialWebhooks={[HOOK]} availableTables={TABLES} ready />,
    );

    await user.click(screen.getByRole("button", { name: "Drop" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Drop webhook notes_webhook/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Drop webhook" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        schema: "public",
        table: "notes",
        name: "notes_webhook",
      });
    });
  });

  test("cancelling the drop confirm fires no write", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(
      <WebhooksClient initialWebhooks={[HOOK]} availableTables={TABLES} ready />,
    );

    await user.click(screen.getByRole("button", { name: "Drop" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  test("creating a webhook confirms first, then POSTs the built body", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(
      <WebhooksClient initialWebhooks={[HOOK]} availableTables={TABLES} ready />,
    );

    await user.click(screen.getByRole("button", { name: "New webhook" }));
    await user.type(screen.getByLabelText("name"), "new_hook");
    await user.type(screen.getByLabelText("url"), "https://hooks.example.com/x");

    // The form's own submit button opens the confirm modal — no POST yet.
    await user.click(screen.getByRole("button", { name: "Create webhook" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Create webhook" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse(post!.init!.body as string);
      expect(body).toMatchObject({
        schema: "marketinghub",
        table: "templates",
        name: "new_hook",
        events: ["insert"],
        url: "https://hooks.example.com/x",
        method: "POST",
      });
    });
  });

  test("rejects a non-http URL client-side without opening the modal", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(
      <WebhooksClient initialWebhooks={[HOOK]} availableTables={TABLES} ready />,
    );

    await user.click(screen.getByRole("button", { name: "New webhook" }));
    await user.type(screen.getByLabelText("name"), "new_hook");
    await user.type(screen.getByLabelText("url"), "ftp://evil.example.com");
    await user.click(screen.getByRole("button", { name: "Create webhook" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/http or https/);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  test("disables webhook creation and warns when the pg_net migration is unapplied", () => {
    mockFetchRoutes();
    render(
      <WebhooksClient
        initialWebhooks={[HOOK]}
        availableTables={TABLES}
        ready={false}
      />,
    );

    expect(screen.getByRole("button", { name: "New webhook" })).toBeDisabled();
    expect(screen.getByText(/NOT applied yet/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-07-scope-pg-net\.sql/)).toBeInTheDocument();
  });
});
