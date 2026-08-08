import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TransformPreview,
  buildRenderUrl,
  isTransformableType,
  type TransformControls,
  type TransformPreviewProps,
} from "./TransformPreview";

// jsdom has no object-URL support — the component always blobs the response.
const createObjectURL = vi.fn(() => "blob:mock-1");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function okResponse() {
  return new Response("png-bytes", {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

function mockRenderFetch(respond: (url: string) => Response = okResponse) {
  const calls: string[] = [];
  const fn = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(respond(url));
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function renderPreview(props: Partial<TransformPreviewProps> = {}) {
  return render(
    <TransformPreview
      bucket="campaign-templates"
      path="brand/logo.png"
      contentType="image/png"
      debounceMs={0}
      {...props}
    />,
  );
}

const controls = (overrides: Partial<TransformControls> = {}): TransformControls => ({
  width: "",
  height: "",
  resize: "fill",
  quality: "",
  format: "origin",
  ...overrides,
});

describe("isTransformableType", () => {
  test("accepts imgproxy-supported image sources only", () => {
    expect(isTransformableType("image/png")).toBe(true);
    expect(isTransformableType("image/jpeg")).toBe(true);
    expect(isTransformableType("image/svg+xml")).toBe(true);
    expect(isTransformableType("image/avif")).toBe(true);
    expect(isTransformableType("application/pdf")).toBe(false);
    expect(isTransformableType("text/html")).toBe(false);
    expect(isTransformableType(null)).toBe(false);
  });
});

describe("buildRenderUrl", () => {
  test("minimal URL carries only bucket and path", () => {
    const url = buildRenderUrl("b", "a/b.png", controls());
    expect(url).toBe("/api/console/storage/render?bucket=b&path=a%2Fb.png");
  });

  test("clamps dimensions and quality to the server bounds", () => {
    const url = buildRenderUrl(
      "b",
      "x.png",
      controls({ width: "5000", height: "0", quality: "5" }),
    );
    expect(url).toContain("width=2000");
    expect(url).toContain("height=1");
    expect(url).toContain("quality=20");
  });

  test("floors fractional values and drops non-numeric ones", () => {
    const url = buildRenderUrl("b", "x.png", controls({ width: "72.9", quality: "abc" }));
    expect(url).toContain("width=72");
    expect(url).not.toContain("quality=");
  });

  test("omits resize without a dimension, includes it with one", () => {
    expect(buildRenderUrl("b", "x.png", controls({ quality: "80" }))).not.toContain("resize=");
    expect(buildRenderUrl("b", "x.png", controls({ width: "320", resize: "cover" }))).toContain(
      "resize=cover",
    );
  });

  test("omits format=origin, includes format=avif", () => {
    expect(buildRenderUrl("b", "x.png", controls())).not.toContain("format=");
    expect(buildRenderUrl("b", "x.png", controls({ format: "avif" }))).toContain("format=avif");
  });
});

describe("TransformPreview", () => {
  test("fetches the render proxy and shows the preview blob", async () => {
    const { calls } = mockRenderFetch();
    renderPreview();

    const img = await screen.findByRole("img", { name: "logo.png" });
    expect(img).toHaveAttribute("src", "blob:mock-1");
    expect(calls[0]).toContain("/api/console/storage/render?");
    expect(calls[0]).toContain("bucket=campaign-templates");
    expect(calls[0]).toContain("path=brand%2Flogo.png");
  });

  test("control changes re-render with clamped params and update the copyable URL", async () => {
    const { calls } = mockRenderFetch();
    const user = userEvent.setup();
    renderPreview();
    await waitFor(() => expect(calls.length).toBe(1));

    await user.type(screen.getByLabelText("Width (px)"), "5000");
    await user.selectOptions(screen.getByLabelText("Format"), "avif");

    await waitFor(() => {
      const last = calls[calls.length - 1];
      expect(last).toContain("width=2000");
      expect(last).toContain("resize=fill");
      expect(last).toContain("format=avif");
    });
    const expected = buildRenderUrl(
      "campaign-templates",
      "brand/logo.png",
      controls({ width: "5000", format: "avif" }),
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  test("debounces rapid control changes into a single fetch", async () => {
    vi.useFakeTimers();
    const { fn, calls } = mockRenderFetch();
    renderPreview({ debounceMs: 300 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fn).toHaveBeenCalledTimes(1);

    const widthInput = screen.getByLabelText("Width (px)");
    fireEvent.change(widthInput, { target: { value: "3" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.change(widthInput, { target: { value: "32" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    fireEvent.change(widthInput, { target: { value: "320" } });
    // 300ms never elapsed uninterrupted — still only the initial fetch.
    expect(fn).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain("width=320");
  });

  test("503 shows the unavailable notice AND falls back to the untransformed inline preview", async () => {
    mockRenderFetch(
      () =>
        new Response(JSON.stringify({ error: "Image transformations are unavailable" }), {
          status: 503,
        }),
    );
    renderPreview();

    expect(
      await screen.findByText("Image transformations are unavailable on this deployment."),
    ).toBeInTheDocument();
    // The raster still displays: the download proxy needs no imgproxy.
    expect(screen.getByRole("img", { name: "logo.png" })).toHaveAttribute(
      "src",
      "/api/console/storage/download?bucket=campaign-templates&path=brand%2Flogo.png&inline=1",
    );
  });

  test("503 on a non-inline-safe type (svg) shows the notice with no fallback image", async () => {
    mockRenderFetch(
      () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    );
    renderPreview({ contentType: "image/svg+xml", path: "brand/logo.svg" });

    expect(
      await screen.findByText("Image transformations are unavailable on this deployment."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("surfaces the API error message on non-503 failures", async () => {
    mockRenderFetch(
      () => new Response(JSON.stringify({ error: "render failed: object not found" }), { status: 404 }),
    );
    renderPreview();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("render failed: object not found");
  });

  test("network failure shows the generic error", async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", fn);
    renderPreview();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network error — please try again.",
    );
  });

  test("non-transformable types show a notice, no controls, and no render fetch", async () => {
    const { fn } = mockRenderFetch();
    renderPreview({ contentType: "application/pdf", path: "docs/report.pdf" });

    expect(
      screen.getByText(/Transforms aren't available for this file type \(application\/pdf\)/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Width (px)")).not.toBeInTheDocument();
    // Flush the (would-be) debounce tick before asserting nothing was fetched.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(fn).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("null content type is treated as non-transformable", () => {
    const { fn } = mockRenderFetch();
    renderPreview({ contentType: null });

    expect(screen.getByText(/Transforms aren't available for this file type\./)).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
  });

  test("copies the absolute render URL to the clipboard", async () => {
    mockRenderFetch();
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "Copy URL" }));

    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain("/api/console/storage/render?bucket=campaign-templates");
    expect(copied).toMatch(/^https?:\/\//);
  });

  test("revokes the previous blob when a new preview replaces it", async () => {
    let n = 0;
    createObjectURL.mockImplementation(() => `blob:mock-${++n}`);
    const { calls } = mockRenderFetch();
    const user = userEvent.setup();
    renderPreview();
    await screen.findByRole("img", { name: "logo.png" });

    await user.type(screen.getByLabelText("Width (px)"), "9");

    await waitFor(() => expect(calls.some((c) => c.includes("width=9"))).toBe(true));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-1"));
  });
});
