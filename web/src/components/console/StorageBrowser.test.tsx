import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  StorageBrowser,
  type BucketDto,
  type EntryDto,
} from "./StorageBrowser";

const BUCKETS: BucketDto[] = [
  { id: "a", name: "campaign-templates", public: false },
  { id: "b", name: "contact-lists", public: false },
];

const ROOT: EntryDto[] = [
  { name: "folder-1", isFolder: true, size: null, mimetype: null, updatedAt: null, path: "folder-1" },
  {
    name: "logo.png",
    isFolder: false,
    size: 2048,
    mimetype: "image/png",
    updatedAt: "2026-08-06T10:00:00Z",
    path: "logo.png",
  },
];

const NESTED: EntryDto[] = [
  {
    name: "notes.txt",
    isFolder: false,
    size: 10,
    mimetype: "text/plain",
    updatedAt: null,
    path: "folder-1/notes.txt",
  },
];

function mockFetchRoutes() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const entries = url.includes("prefix=folder-1") ? NESTED : ROOT;
      return Promise.resolve(
        new Response(JSON.stringify({ buckets: BUCKETS, entries }), { status: 200 }),
      );
    }
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ deleted: 1 }), { status: 200 }),
      );
    }
    if (method === "PATCH") {
      return Promise.resolve(
        new Response(JSON.stringify({ moved: "x" }), { status: 200 }),
      );
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ uploaded: "up.bin" }), { status: 201 }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderBrowser() {
  return render(
    <StorageBrowser
      initialBuckets={BUCKETS}
      initialBucket="campaign-templates"
      initialEntries={ROOT}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StorageBrowser", () => {
  test("renders entries with type badges, sizes, and a download link", () => {
    mockFetchRoutes();
    renderBrowser();

    expect(screen.getByText("folder-1/")).toBeInTheDocument();
    expect(screen.getByText("logo.png")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute(
      "href",
      expect.stringContaining("bucket=campaign-templates"),
    );
  });

  test("clicking a folder drills in and fetches that prefix", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole("button", { name: "folder-1/" }));

    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
    expect(calls.some((c) => c.url.includes("prefix=folder-1"))).toBe(true);
  });

  test("switching buckets resets to the root of the new bucket", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    await user.selectOptions(screen.getByLabelText("Bucket"), "contact-lists");

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("bucket=contact-lists"))).toBe(true),
    );
  });

  test("delete is two-step and DELETEs the exact path", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === "DELETE");
      expect(del).toBeDefined();
      expect(JSON.parse(del!.init!.body as string)).toEqual({
        bucket: "campaign-templates",
        paths: ["logo.png"],
      });
    });
  });

  test("rename PATCHes from → to", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("New path for logo.png");
    await user.clear(input);
    await user.type(input, "brand/logo-2.png");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch!.init!.body as string)).toEqual({
        bucket: "campaign-templates",
        from: "logo.png",
        to: "brand/logo-2.png",
      });
    });
  });

  test("uploading a file POSTs multipart form data for the current location", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    const file = new File(["data"], "up.bin", { type: "application/octet-stream" });
    await user.upload(screen.getByLabelText("Choose file to upload"), file);

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === "POST");
      expect(post).toBeDefined();
      const form = post!.init!.body as FormData;
      expect(form.get("bucket")).toBe("campaign-templates");
      expect((form.get("file") as File).name).toBe("up.bin");
    });
  });

  test("image preview renders through the inline proxy", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole("button", { name: "Preview" }));

    const img = screen.getByRole("img", { name: "logo.png" });
    expect(img).toHaveAttribute("src", expect.stringContaining("inline=1"));
  });
});
