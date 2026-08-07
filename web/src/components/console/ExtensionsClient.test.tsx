import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExtensionsClient, type ExtensionDto } from "./ExtensionsClient";

const PG_CRON: ExtensionDto = {
  name: "pg_cron",
  schema: "pg_catalog",
  default_version: "1.6",
  installed_version: "1.6",
  comment: "Job scheduler for PostgreSQL",
};

const POSTGIS: ExtensionDto = {
  name: "postgis",
  schema: null,
  default_version: "3.4.0",
  installed_version: null,
  comment: "PostGIS spatial types",
};

/** Route-aware fetch mock: GET refresh, POST enable, DELETE drop. */
function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ extensions: [PG_CRON, POSTGIS] }), { status: 200 }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ enabled: "postgis" }), { status: 201 }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ dropped: "pg_cron" }), { status: 200 }),
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

describe("ExtensionsClient", () => {
  test("renders installed + available state with no confirm on browse", () => {
    mockFetchRoutes();
    render(<ExtensionsClient initialExtensions={[PG_CRON, POSTGIS]} />);

    expect(screen.getByText("pg_cron")).toBeInTheDocument();
    expect(screen.getByText("postgis")).toBeInTheDocument();
    // Installed carries its version badge; available says so.
    expect(screen.getAllByText("1.6").length).toBeGreaterThan(0);
    expect(screen.getByText("available")).toBeInTheDocument();
    expect(screen.getByText("3.4.0")).toBeInTheDocument();
    // Just browsing: no interrupting modal.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  test("enabling pops the confirm modal and only POSTs on confirm", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<ExtensionsClient initialExtensions={[PG_CRON, POSTGIS]} />);

    await user.click(screen.getByRole("button", { name: "Enable" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/CREATE EXTENSION/);
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Enable extension" }));

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(post!.init!.body as string)).toEqual({ name: "postgis" });
    });
  });

  test("dropping pops the confirm modal and only DELETEs on confirm", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<ExtensionsClient initialExtensions={[PG_CRON, POSTGIS]} />);

    await user.click(screen.getByRole("button", { name: "Drop" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/DROP EXTENSION/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Drop extension" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({ name: "pg_cron" });
    });
  });

  test("cancelling the confirm modal fires no write", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    render(<ExtensionsClient initialExtensions={[PG_CRON, POSTGIS]} />);

    await user.click(screen.getByRole("button", { name: "Enable" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });
});
