import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  RESUMABLE_CHUNK_BYTES,
  RESUMABLE_ENDPOINT,
  RESUMABLE_MAX_BYTES,
  RESUMABLE_RETRY_DELAYS,
} from "./resumable";

interface MockProgress {
  uploadStarted: number | null;
  bytesUploaded: number | false;
  bytesTotal: number | null;
  uploadComplete: boolean;
}

interface MockFile {
  id: string;
  name: string;
  type: string;
  size: number;
  data: File;
  meta: Record<string, unknown>;
  error: string | null;
  isPaused: boolean;
  progress: MockProgress;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => void;

const h = vi.hoisted(() => {
  class MockTus {}

  class MockUppy {
    static instances: MockUppy[] = [];

    opts: { restrictions?: { maxFileSize?: number | null } };
    plugins: Array<{ plugin: unknown; opts: Record<string, unknown> }> = [];
    handlers = new Map<string, AnyFn[]>();
    files = new Map<string, MockFile>();
    retried: string[] = [];
    destroyed = 0;
    private seq = 0;

    constructor(opts: { restrictions?: { maxFileSize?: number | null } }) {
      this.opts = opts;
      MockUppy.instances.push(this);
    }

    use(plugin: unknown, opts: Record<string, unknown>) {
      this.plugins.push({ plugin, opts });
      return this;
    }

    on(event: string, fn: AnyFn) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
    }

    addFile(file: File) {
      const max = this.opts.restrictions?.maxFileSize;
      if (max != null && file.size > max) {
        const error = new Error(`${file.name} exceeds the resumable upload cap`);
        this.emit("restriction-failed", { name: file.name }, error);
        throw error;
      }
      const id = `uppy-${++this.seq}`;
      const entry: MockFile = {
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        data: file,
        meta: { name: file.name },
        error: null,
        isPaused: false,
        progress: {
          uploadStarted: null,
          bytesUploaded: false,
          bytesTotal: file.size,
          uploadComplete: false,
        },
      };
      this.files.set(id, entry);
      this.emit("file-added", entry);
      return id;
    }

    removeFile(id: string) {
      const entry = this.files.get(id);
      this.files.delete(id);
      if (entry) this.emit("file-removed", entry);
    }

    getFiles() {
      return [...this.files.values()];
    }

    setFileMeta(id: string, patch: Record<string, unknown>) {
      const entry = this.files.get(id);
      if (entry) entry.meta = { ...entry.meta, ...patch };
    }

    pauseResume(id: string) {
      const entry = this.files.get(id);
      if (!entry) return undefined;
      entry.isPaused = !entry.isPaused;
      this.emit("upload-pause", entry, entry.isPaused);
      return entry.isPaused;
    }

    retryUpload(id: string) {
      this.retried.push(id);
      const entry = this.files.get(id);
      if (entry) entry.error = null;
      return Promise.resolve(undefined);
    }

    destroy() {
      this.destroyed += 1;
    }
  }

  return { MockUppy, MockTus };
});

vi.mock("@uppy/core", () => ({ default: h.MockUppy }));
vi.mock("@uppy/tus", () => ({ default: h.MockTus }));

import { ResumableUploader, type ResumableUploaderProps } from "./ResumableUploader";

function renderUploader(props?: Partial<ResumableUploaderProps>) {
  return render(<ResumableUploader bucket="assets" prefix="brand" {...props} />);
}

function lastUppy() {
  const instance = h.MockUppy.instances.at(-1);
  if (!instance) throw new Error("no uppy instance created");
  return instance;
}

const chooseInput = () =>
  screen.getByLabelText("Choose files for resumable upload");

beforeEach(() => {
  h.MockUppy.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResumableUploader", () => {
  test("configures uppy + tus per the proxy contract", () => {
    renderUploader();
    const uppy = lastUppy();

    expect(uppy.opts.restrictions).toEqual({ maxFileSize: RESUMABLE_MAX_BYTES });
    expect(uppy.plugins).toHaveLength(1);
    expect(uppy.plugins[0].plugin).toBe(h.MockTus);

    const tusOpts = uppy.plugins[0].opts;
    expect(tusOpts.endpoint).toBe(RESUMABLE_ENDPOINT);
    expect(tusOpts.endpoint).toBe("/api/console/storage/tus");
    expect(tusOpts.chunkSize).toBe(RESUMABLE_CHUNK_BYTES);
    expect(tusOpts.retryDelays).toEqual(RESUMABLE_RETRY_DELAYS);
    expect(tusOpts.allowedMetaFields).toEqual([
      "bucketName",
      "objectName",
      "contentType",
      "cacheControl",
    ]);
    // No overwrite by default — x-upsert must not be sent.
    const headers = tusOpts.headers as () => Record<string, string>;
    expect(headers()).toEqual({});
  });

  test("allowOverwrite opts into x-upsert", () => {
    renderUploader({ allowOverwrite: true });
    const headers = lastUppy().plugins[0].opts.headers as () => Record<string, string>;
    expect(headers()).toEqual({ "x-upsert": "true" });
  });

  test("adding a file sets Supabase Upload-Metadata from bucket + prefix", async () => {
    const user = userEvent.setup();
    renderUploader();

    const file = new File(["data"], "logo bits.png", { type: "image/png" });
    await user.upload(chooseInput(), file);

    expect(screen.getByText("brand/logo bits.png")).toBeInTheDocument();
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(lastUppy().getFiles()[0].meta).toMatchObject({
      bucketName: "assets",
      objectName: "brand/logo bits.png",
      contentType: "image/png",
      cacheControl: "3600",
    });
  });

  test("root uploads use the bare file name", async () => {
    const user = userEvent.setup();
    renderUploader({ prefix: "" });

    await user.upload(chooseInput(), new File(["x"], "a.bin", { type: "" }));

    expect(lastUppy().getFiles()[0].meta).toMatchObject({
      objectName: "a.bin",
      contentType: "application/octet-stream",
    });
  });

  test("rejects unsafe file names before any bytes move", async () => {
    const user = userEvent.setup();
    renderUploader();

    await user.upload(chooseInput(), new File(["x"], "bad%name.bin"));

    expect(lastUppy().getFiles()).toHaveLength(0);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("bad%name.bin");
    expect(alert).toHaveTextContent("Unsafe object name");

    await user.click(screen.getByRole("button", { name: "Dismiss bad%name.bin" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("files over the TUS cap are refused client-side", async () => {
    const user = userEvent.setup();
    renderUploader();

    const big = new File(["x"], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(big, "size", { value: RESUMABLE_MAX_BYTES + 1 });
    await user.upload(chooseInput(), big);

    expect(lastUppy().getFiles()).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "big.bin exceeds the resumable upload cap",
    );
  });

  test("shows progress and supports pause/resume", async () => {
    const user = userEvent.setup();
    renderUploader();

    await user.upload(chooseInput(), new File(["chunk"], "video.mp4", { type: "video/mp4" }));
    const uppy = lastUppy();
    const file = uppy.getFiles()[0];

    act(() => {
      file.progress = {
        uploadStarted: Date.now(),
        bytesUploaded: 3 * 1024 * 1024,
        bytesTotal: 6 * 1024 * 1024,
        uploadComplete: false,
      };
      uppy.emit("upload-progress", file, file.progress);
    });

    expect(
      screen.getByRole("progressbar", { name: "Upload progress for brand/video.mp4" }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("uploading")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause brand/video.mp4" }));
    expect(file.isPaused).toBe(true);
    expect(screen.getByText("paused")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume brand/video.mp4" }));
    expect(file.isPaused).toBe(false);
    expect(screen.getByText("uploading")).toBeInTheDocument();
  });

  test("upload-success marks the row done and fires onUploaded with the object key", async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    renderUploader({ onUploaded });

    await user.upload(chooseInput(), new File(["data"], "logo.png", { type: "image/png" }));
    const uppy = lastUppy();
    const file = uppy.getFiles()[0];

    act(() => {
      file.progress = {
        uploadStarted: 1,
        bytesUploaded: file.size,
        bytesTotal: file.size,
        uploadComplete: true,
      };
      uppy.emit("upload-success", file, { status: 204 });
    });

    expect(screen.getByText("done")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Upload progress for brand/logo.png" }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(onUploaded).toHaveBeenCalledWith("brand/logo.png");
  });

  test("upload-error shows a per-file error and Retry re-queues it", async () => {
    const user = userEvent.setup();
    renderUploader();

    await user.upload(chooseInput(), new File(["data"], "logo.png", { type: "image/png" }));
    const uppy = lastUppy();
    const file = uppy.getFiles()[0];

    act(() => {
      file.error = "tus: failed to upload chunk (response code 413)";
      uppy.emit("upload-error", file, { name: "Error", message: file.error });
    });

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "tus: failed to upload chunk (response code 413)",
    );

    await user.click(screen.getByRole("button", { name: "Retry brand/logo.png" }));
    expect(uppy.retried).toEqual([file.id]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("remove drops the row and the uppy file", async () => {
    const user = userEvent.setup();
    renderUploader();

    await user.upload(chooseInput(), new File(["data"], "logo.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Remove brand/logo.png" }));

    expect(lastUppy().getFiles()).toHaveLength(0);
    expect(screen.queryByText("brand/logo.png")).not.toBeInTheDocument();
  });

  test("add button is disabled without a bucket or when disabled", () => {
    renderUploader({ bucket: "" });
    expect(screen.getByRole("button", { name: "Add files" })).toBeDisabled();

    renderUploader({ disabled: true });
    const buttons = screen.getAllByRole("button", { name: "Add files" });
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });

  test("destroys the uppy instance on unmount", () => {
    const { unmount } = renderUploader();
    const uppy = lastUppy();
    unmount();
    expect(uppy.destroyed).toBe(1);
  });
});
