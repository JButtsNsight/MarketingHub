import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  StorageBrowser,
  type BucketRow,
  type EntryDto,
} from "./StorageBrowser";

// The browser imports ResumableUploader, which pulls in uppy — stub the uppy
// modules so tests exercise our UI, not the upload engine (which has its own
// suite in components/storage/ResumableUploader.test.tsx). The stub records
// addFile calls so tests can assert which transport an upload routed through.
const h = vi.hoisted(() => {
  class MockTus {}
  class MockUppy {
    static instances: MockUppy[] = [];
    added: File[] = [];

    constructor() {
      MockUppy.instances.push(this);
    }
    use() {
      return this;
    }
    on() {
      return this;
    }
    getFiles() {
      return [];
    }
    addFile(file: File) {
      this.added.push(file);
    }
    removeFile() {}
    setFileMeta() {}
    pauseResume() {}
    retryUpload() {
      return Promise.resolve();
    }
    destroy() {}
  }
  return { MockTus, MockUppy };
});
vi.mock("@uppy/core", () => ({ default: h.MockUppy }));
vi.mock("@uppy/tus", () => ({ default: h.MockTus }));

const BUCKETS: BucketRow[] = [
  {
    id: "a",
    name: "campaign-templates",
    public: false,
    createdAt: null,
    fileSizeLimit: null,
    allowedMimeTypes: null,
  },
  {
    id: "b",
    name: "contact-lists",
    public: false,
    createdAt: null,
    fileSizeLimit: null,
    allowedMimeTypes: null,
  },
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
      if (url.includes("/render")) {
        return Promise.resolve(
          new Response("png-bytes", {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      }
      if (url.includes("/buckets")) {
        return Promise.resolve(
          new Response(JSON.stringify({ buckets: BUCKETS }), { status: 200 }),
        );
      }
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
  h.MockUppy.instances = [];
});

function lastUppy() {
  const instance = h.MockUppy.instances.at(-1);
  if (!instance) throw new Error("no uppy instance created");
  return instance;
}

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

  test("small files POST multipart form data for the current location", async () => {
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
    // Small files never touch the TUS engine.
    expect(lastUppy().added).toHaveLength(0);
  });

  test("files past one TUS chunk route through the resumable path automatically", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    // There is exactly one upload control — no "Large files" mode to pick.
    expect(
      screen.queryByRole("button", { name: "Large files" }),
    ).not.toBeInTheDocument();

    const big = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(big, "size", { value: 7 * 1024 * 1024 });
    await user.upload(screen.getByLabelText("Choose file to upload"), big);

    // The file went to the TUS engine, not the classic POST.
    expect(lastUppy().added.map((f) => f.name)).toEqual(["video.mp4"]);
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  });

  test("image preview mounts the transform preview against the render proxy", async () => {
    const { calls } = mockFetchRoutes();
    // jsdom has no object-URL support — TransformPreview blobs the response.
    const createObjectURL = vi.fn(() => "blob:preview-1");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const user = userEvent.setup();
    renderBrowser();

    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "logo.png" })).toHaveAttribute(
        "src",
        "blob:preview-1",
      ),
    );
    expect(
      calls.some(
        (c) =>
          c.url.includes("/api/console/storage/render?") &&
          c.url.includes("path=logo.png"),
      ),
    ).toBe(true);
  });

  test("bucket management panel lists per-bucket edit/empty/delete affordances", () => {
    mockFetchRoutes();
    renderBrowser();

    expect(screen.getByRole("heading", { name: "Buckets" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Empty" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete…" })).toHaveLength(2);
  });

  test("emptying the current bucket reloads its listing at the root", async () => {
    const { calls } = mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    // Drill into a folder first so the reload provably lands back at the root.
    await user.click(screen.getByRole("button", { name: "folder-1/" }));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());
    const before = calls.filter((c) => c.url.includes("/objects")).length;

    // campaign-templates (the selected bucket) is the first manager row.
    await user.click(screen.getAllByRole("button", { name: "Empty" })[0]);
    const modal = screen.getByRole("alertdialog");
    await user.type(
      within(modal).getByLabelText(/to confirm/),
      "campaign-templates",
    );
    await user.click(within(modal).getByRole("button", { name: "Empty bucket" }));

    await waitFor(() => {
      const objectLoads = calls.filter((c) => c.url.includes("/objects"));
      expect(objectLoads.length).toBeGreaterThan(before);
      expect(objectLoads[objectLoads.length - 1].url).not.toContain("prefix=");
    });
  });

  test("the rail's New bucket chip opens the create dialog", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    // First match is the toolbar chip (the manager section repeats the action).
    const [railCreate] = screen.getAllByRole("button", { name: "New bucket" });
    await user.click(railCreate);

    expect(screen.getByRole("dialog", { name: "New bucket" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("the breadcrumb reads as a path: ancestor links, current segment plain", async () => {
    mockFetchRoutes();
    const user = userEvent.setup();
    renderBrowser();

    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    // At the bucket root the single segment is plain text — nothing to click.
    expect(within(nav).queryByRole("button")).not.toBeInTheDocument();
    expect(within(nav).getByText("campaign-templates")).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "folder-1/" }));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeInTheDocument());

    // Drilled in: the bucket is a link back up, the folder is the plain current segment.
    const current = within(nav).getByText("folder-1");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.tagName).not.toBe("BUTTON");
    await user.click(within(nav).getByRole("button", { name: "campaign-templates" }));

    await waitFor(() => expect(screen.getByText("logo.png")).toBeInTheDocument());
  });
});
