"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Surface } from "../Surface";
import { Guide } from "@/components/guide/Guide";

/**
 * Transform preview for a selected Storage object (Studio parity): width /
 * height / resize / quality / format controls rendered through the group-gated
 * GET /api/console/storage/render proxy (storage-api /render/image + imgproxy).
 *
 * The preview is fetched with fetch() and shown via an object URL — not an
 * <img src> pointed straight at the route — so a 503 (transforms disabled
 * upstream) surfaces as a message instead of a broken image, and the route's
 * content-disposition guard never affects display.
 *
 * Non-transformable content types get a plain notice and fall back to the
 * existing untransformed /api/console/storage/download?inline=1 preview when
 * the type is in that route's inline-safe raster set. A 503 from the render
 * route (transforms disabled / imgproxy down) takes the same fallback: the
 * download proxy works without imgproxy, so raster previews never regress.
 *
 * Integrators should key the component per object (key={`${bucket}/${path}`})
 * so controls reset when the selection changes.
 */

// Server bounds mirrored from web/src/lib/console/storage.ts (server-only, so
// not importable here): dimensions clamp to [1,2000], quality to [20,100].
const DIMENSION_MIN = 1;
const DIMENSION_MAX = 2000;
const QUALITY_MIN = 20;
const QUALITY_MAX = 100;

export type ResizeMode = "cover" | "contain" | "fill";
export type FormatOption = "origin" | "avif";

export interface TransformControls {
  /** Raw input values — empty string means "not set". */
  width: string;
  height: string;
  resize: ResizeMode;
  quality: string;
  format: FormatOption;
}

// Source types imgproxy v3.30.1 accepts behind the render endpoint. Non-image
// sources make imgproxy error, so the UI never offers transforms for them.
const TRANSFORMABLE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/;

// Untransformed fallback — must match the download route's INLINE_SAFE set.
const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp)$/;

export function isTransformableType(contentType: string | null | undefined): boolean {
  return contentType != null && TRANSFORMABLE.test(contentType);
}

function clampInt(raw: string, min: number, max: number): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Render-proxy URL for the given controls, clamped exactly like the server. */
export function buildRenderUrl(
  bucket: string,
  path: string,
  controls: TransformControls,
): string {
  const params = new URLSearchParams({ bucket, path });
  const width = clampInt(controls.width, DIMENSION_MIN, DIMENSION_MAX);
  const height = clampInt(controls.height, DIMENSION_MIN, DIMENSION_MAX);
  const quality = clampInt(controls.quality, QUALITY_MIN, QUALITY_MAX);
  if (width != null) params.set("width", String(width));
  if (height != null) params.set("height", String(height));
  // resize is inert without a dimension — keep the copyable URL minimal.
  if (width != null || height != null) params.set("resize", controls.resize);
  if (quality != null) params.set("quality", String(quality));
  if (controls.format !== "origin") params.set("format", controls.format);
  return `/api/console/storage/render?${params}`;
}

export interface TransformPreviewProps {
  bucket: string;
  path: string;
  contentType: string | null;
  /** Delay before control changes trigger a re-render fetch (ms). */
  debounceMs?: number;
}

export function TransformPreview({
  bucket,
  path,
  contentType,
  debounceMs = 350,
}: TransformPreviewProps) {
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [resize, setResize] = useState<ResizeMode>("fill");
  const [quality, setQuality] = useState("");
  const [format, setFormat] = useState<FormatOption>("origin");
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fetchSeq = useRef(0);
  const objectUrl = useRef<string | null>(null);

  const transformable = isTransformableType(contentType);
  const previewable = contentType != null && PREVIEWABLE.test(contentType);
  const name = path.split("/").pop() ?? path;
  const inlineFallbackSrc = `/api/console/storage/download?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&inline=1`;
  const url = useMemo(
    () => buildRenderUrl(bucket, path, { width, height, resize, quality, format }),
    [bucket, path, width, height, resize, quality, format],
  );

  // Debounced render: every control change resets the timer; stale responses
  // are dropped via the sequence guard, and replaced blobs are revoked.
  useEffect(() => {
    if (!transformable) return;
    const seq = ++fetchSeq.current;
    const timer = window.setTimeout(async () => {
      const clear = () => {
        if (objectUrl.current) {
          URL.revokeObjectURL(objectUrl.current);
          objectUrl.current = null;
        }
        setPreviewSrc(null);
      };
      setLoading(true);
      setError(null);
      setUnavailable(false);
      try {
        const res = await fetch(url);
        if (seq !== fetchSeq.current) return;
        if (res.status === 503) {
          setUnavailable(true);
          clear();
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (seq !== fetchSeq.current) return;
          setError(body?.error ?? "Rendering the preview failed.");
          clear();
          return;
        }
        const blob = await res.blob();
        if (seq !== fetchSeq.current) return;
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(blob);
        setPreviewSrc(objectUrl.current);
      } catch {
        if (seq === fetchSeq.current) {
          setError("Network error — please try again.");
          clear();
        }
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [transformable, url, debounceMs]);

  // Release the last preview blob on unmount.
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const copy = async () => {
    try {
      const absolute =
        typeof window === "undefined" ? url : new URL(url, window.location.origin).toString();
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (insecure context / denied) — non-fatal */
    }
  };

  if (!transformable) {
    return (
      <Surface className="storage-preview" glint>
        <span className="eyebrow">{path}</span>
        <Guide id="storage.transform.no-transforms">
          <p className="note">
            Transforms aren&apos;t available for this file type
            {contentType ? ` (${contentType})` : ""}.
          </p>
        </Guide>
        {previewable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={inlineFallbackSrc} alt={name} />
        ) : null}
      </Surface>
    );
  }

  return (
    <Surface className="storage-preview" glint>
      <span className="eyebrow">{path}</span>

      <div className="dgrid-toolbar">
        <Guide id="storage.transform.width">
          <input
            type="number"
            className="surface control teditor-fctl"
            aria-label="Width (px)"
            placeholder="width"
            min={DIMENSION_MIN}
            max={DIMENSION_MAX}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
          />
        </Guide>
        <Guide id="storage.transform.height">
          <input
            type="number"
            className="surface control teditor-fctl"
            aria-label="Height (px)"
            placeholder="height"
            min={DIMENSION_MIN}
            max={DIMENSION_MAX}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
          />
        </Guide>
        <Guide id="storage.transform.resize">
          <select
            className="surface control teditor-fctl"
            aria-label="Resize mode"
            value={resize}
            onChange={(e) => setResize(e.target.value as ResizeMode)}
          >
            <option value="cover">cover</option>
            <option value="contain">contain</option>
            <option value="fill">fill</option>
          </select>
        </Guide>
        <Guide id="storage.transform.quality">
          <input
            type="number"
            className="surface control teditor-fctl"
            aria-label="Quality"
            placeholder="quality"
            min={QUALITY_MIN}
            max={QUALITY_MAX}
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
          />
        </Guide>
        <Guide id="storage.transform.format">
          <select
            className="surface control teditor-fctl"
            aria-label="Format"
            value={format}
            onChange={(e) => setFormat(e.target.value as FormatOption)}
          >
            <option value="origin">origin</option>
            <option value="avif">avif</option>
          </select>
        </Guide>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {unavailable ? (
        <>
          <Guide id="storage.transform.unavailable">
            <p className="note" role="status">
              Image transformations are unavailable on this deployment.
            </p>
          </Guide>
          {previewable ? (
            // Transforms down ≠ preview down — the untransformed inline proxy
            // needs no imgproxy, so rasters keep displaying.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={inlineFallbackSrc} alt={name} />
          ) : null}
        </>
      ) : null}

      {previewSrc ? (
        <div className={loading ? "dgrid-busy" : undefined}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewSrc} alt={name} />
        </div>
      ) : null}

      <div className="campaign-actions">
        <span className="note mono">{url}</span>
        <Guide id="storage.transform.copy-url">
          <button type="button" className="type-chip" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy URL"}
          </button>
        </Guide>
      </div>
    </Surface>
  );
}

export default TransformPreview;
