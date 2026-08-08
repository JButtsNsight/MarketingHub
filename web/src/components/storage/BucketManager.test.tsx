import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BucketManager, type BucketRow } from "./BucketManager";

const BUCKETS: BucketRow[] = [
  {
    id: "a",
    name: "campaign-templates",
    public: false,
    createdAt: "2026-08-01T00:00:00Z",
    fileSizeLimit: null,
    allowedMimeTypes: null,
  },
  {
    id: "b",
    name: "public-assets",
    public: true,
    createdAt: null,
    fileSizeLimit: 10485760,
    allowedMimeTypes: ["image/png", "image/*"],
  },
];

function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ deleted: "x" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderManager(onBucketsChanged?: (buckets: BucketRow[]) => void) {
  return render(
    <BucketManager initialBuckets={BUCKETS} onBucketsChanged={onBucketsChanged} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BucketManager", () => {
  test("renders buckets with visibility badges, size limits, and allow-lists", () => {
    mockFetchRoutes();
    renderManager();

    expect(screen.getByText("campaign-templates")).toBeInTheDocument();
    expect(screen.getByText("public-assets")).toBeInTheDocument();
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText("10.0 MB")).toBeInTheDocument();
    expect(screen.getByText("any")).toBeInTheDocument();
    expect(screen.getByText("image/png, image/*")).toBeInTheDocument();
  });

  test("New bucket opens the create dialog", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByRole("button", { name: "New bucket" }));

    const nameInput = screen.getByLabelText("Bucket name");
    expect(nameInput).toBeEnabled();
    expect(nameInput).toHaveValue("");
  });

  test("Edit opens the dialog with the bucket's settings and immutable name", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);

    const nameInput = screen.getByLabelText("Bucket name");
    expect(nameInput).toBeDisabled();
    expect(nameInput).toHaveValue("public-assets");
  });

  test("Empty demands the typed bucket name, then DELETEs with action empty + confirm echo", async () => {
    const { calls } = mockFetchRoutes();
    const onEmptied = vi.fn();
    const user = userEvent.setup();
    render(
      <BucketManager initialBuckets={BUCKETS} onEmptied={onEmptied} />,
    );

    await user.click(screen.getAllByRole("button", { name: "Empty" })[1]);
    const modal = screen.getByRole("alertdialog");
    expect(modal).toHaveTextContent(/every object in "public-assets"/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    await user.type(within(modal).getByLabelText(/to confirm/), "public-assets");
    await user.click(within(modal).getByRole("button", { name: "Empty bucket" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(del!.url).toBe("/api/console/storage/buckets");
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        name: "public-assets",
        action: "empty",
        confirm: "public-assets",
      });
    });
    await waitFor(() => expect(onEmptied).toHaveBeenCalledWith("public-assets"));
  });

  test("Empty refuses when the typed bucket name does not match", async () => {
    const { calls } = mockFetchRoutes();
    const onEmptied = vi.fn();
    const user = userEvent.setup();
    render(
      <BucketManager initialBuckets={BUCKETS} onEmptied={onEmptied} />,
    );

    await user.click(screen.getAllByRole("button", { name: "Empty" })[1]);
    const modal = screen.getByRole("alertdialog");
    await user.type(within(modal).getByLabelText(/to confirm/), "public-asset");
    await user.click(within(modal).getByRole("button", { name: "Empty bucket" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/did not match/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    expect(onEmptied).not.toHaveBeenCalled();
  });

  test("cancelling the Empty modal sends nothing", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: "Empty" })[0]);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  test("Delete refuses when the typed bucket name does not match", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[0]);
    const modal = screen.getByRole("alertdialog");
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      "something-else",
    );
    await user.click(
      within(modal).getByRole("button", { name: "Delete bucket" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/did not match/);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
  });

  test("Delete with the exact typed name DELETEs and refreshes the list", async () => {
    const { calls } = mockFetchRoutes();
    const onBucketsChanged = vi.fn();
    const user = userEvent.setup();
    renderManager(onBucketsChanged);

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[0]);
    const modal = screen.getByRole("alertdialog");
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      "campaign-templates",
    );
    await user.click(
      within(modal).getByRole("button", { name: "Delete bucket" }),
    );

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        name: "campaign-templates",
        action: "delete",
        confirm: "campaign-templates",
      });
    });
    await waitFor(() => {
      expect(calls.some((c) => (c.init?.method ?? "GET") === "GET")).toBe(true);
      expect(onBucketsChanged).toHaveBeenCalledWith(BUCKETS);
    });
  });

  test("surfaces the route's error when a delete is refused", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "delete-bucket failed: bucket not empty" }),
            { status: 400 },
          ),
        );
      }),
    );
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getAllByRole("button", { name: "Delete…" })[0]);
    const modal = screen.getByRole("alertdialog");
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      "campaign-templates",
    );
    await user.click(
      within(modal).getByRole("button", { name: "Delete bucket" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "delete-bucket failed: bucket not empty",
      ),
    );
  });
});
