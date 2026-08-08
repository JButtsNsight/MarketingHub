import { afterEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BucketFormDialog, type BucketRow } from "./BucketFormDialog";

const EXISTING: BucketRow = {
  id: "b",
  name: "public-assets",
  public: true,
  createdAt: "2026-08-01T00:00:00Z",
  fileSizeLimit: 5242880, // exactly 5 MB
  allowedMimeTypes: ["image/png", "image/*"],
};

function mockFetch(status = 201, body: unknown = { created: "x" }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BucketFormDialog (create)", () => {
  test("POSTs the full settings body with the size limit converted to bytes", async () => {
    const { calls } = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={onClose} />);

    await user.type(screen.getByLabelText("Bucket name"), "assets");
    await user.click(screen.getByLabelText(/Public bucket/));
    await user.type(screen.getByLabelText("File size limit"), "10");
    await user.selectOptions(screen.getByLabelText("Unit"), "MB");
    await user.type(
      screen.getByLabelText("Allowed MIME types"),
      "image/png, image/*",
    );
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe("/api/console/storage/buckets");
    expect(JSON.parse(post!.init!.body as string)).toEqual({
      name: "assets",
      public: true,
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: ["image/png", "image/*"],
    });
  });

  test("empty size limit and MIME list are sent as explicit nulls", async () => {
    const { calls } = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={onClose} />);

    await user.type(screen.getByLabelText("Bucket name"), "plain");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      name: "plain",
      public: false,
      fileSizeLimit: null,
      allowedMimeTypes: null,
    });
  });

  test("toggling Public shows the plain-language warning", async () => {
    mockFetch();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={vi.fn()} />);

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Public bucket/));
    expect(screen.getByRole("note")).toHaveTextContent(
      /anyone with an object's URL can read it/i,
    );
  });

  test("rejects a bad bucket name before any request", async () => {
    const { fn } = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={onClose} />);

    await user.type(screen.getByLabelText("Bucket name"), "bad name!");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/Bucket names/);
    expect(fn).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test("rejects a duplicate name against existingNames", async () => {
    const { fn } = mockFetch();
    const user = userEvent.setup();
    render(
      <BucketFormDialog
        mode="create"
        existingNames={["assets"]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Bucket name"), "assets");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("rejects a malformed MIME type before any request", async () => {
    const { fn } = mockFetch();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Bucket name"), "assets");
    await user.type(screen.getByLabelText("Allowed MIME types"), "not-a-mime");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/not a valid MIME type/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("rejects a size limit that is not a whole number of bytes", async () => {
    const { fn } = mockFetch();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Bucket name"), "assets");
    await user.type(screen.getByLabelText("File size limit"), "0.5");
    await user.selectOptions(screen.getByLabelText("Unit"), "B");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/whole number of bytes/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("surfaces the route's error body and stays open", async () => {
    mockFetch(400, { error: "create-bucket failed: duplicate" });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={onClose} />);

    await user.type(screen.getByLabelText("Bucket name"), "assets");
    await user.click(screen.getByRole("button", { name: "Create bucket" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "create-bucket failed: duplicate",
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  test("cancel closes without saving or fetching", async () => {
    const { fn } = mockFetch();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<BucketFormDialog mode="create" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledWith(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("BucketFormDialog (edit)", () => {
  test("name is immutable and settings prefill in the largest exact unit", () => {
    mockFetch();
    render(<BucketFormDialog mode="edit" bucket={EXISTING} onClose={vi.fn()} />);

    const nameInput = screen.getByLabelText("Bucket name");
    expect(nameInput).toBeDisabled();
    expect(nameInput).toHaveValue("public-assets");
    expect(screen.getByLabelText("File size limit")).toHaveValue(5);
    expect(screen.getByLabelText("Unit")).toHaveValue("MB");
    expect(screen.getByLabelText("Allowed MIME types")).toHaveValue(
      "image/png, image/*",
    );
    expect(screen.getByLabelText(/Public bucket/)).toBeChecked();
  });

  test("PATCHes the immutable name with public always explicit", async () => {
    const { calls } = mockFetch(200, { updated: "public-assets" });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <BucketFormDialog mode="edit" bucket={EXISTING} onClose={onClose} />,
    );

    // Make it private and clear the limit + allow-list (explicit nulls).
    await user.click(screen.getByLabelText(/Public bucket/));
    await user.clear(screen.getByLabelText("File size limit"));
    await user.clear(screen.getByLabelText("Allowed MIME types"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.url).toBe("/api/console/storage/buckets");
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      name: "public-assets",
      public: false,
      fileSizeLimit: null,
      allowedMimeTypes: null,
    });
  });
});
