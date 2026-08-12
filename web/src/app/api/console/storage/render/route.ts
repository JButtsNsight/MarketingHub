import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  bucketExists,
  fetchTransformedImage,
  isSafeBucketName,
  isSafePath,
  normalizeTransform,
  CAMPAIGN_BUCKET,
  TransformUnavailableError,
  type TransformOptions,
} from "@/lib/console/storage";

/**
 * Transform-preview proxy, gated on the platform section:
 *
 * - GET ?bucket&path&width&height&resize&quality&format → streams the
 *   transformed object from the storage-api render endpoint (imgproxy).
 *
 * The render endpoint lives on the PRIVATE internal Supabase host, so this
 *   server fetches with the service key and proxies the bytes — the browser
 *   never reaches Supabase. Dimensions/quality are clamped and enums
 *   validated BEFORE the upstream call; a down transform capability
 *   (imgproxy unreachable / routes unregistered) answers 503, not 400.
 */

export const dynamic = "force-dynamic";

/**
 * Content types safe to serve INLINE from the app origin — same guard as the
 * download route, deliberately raster images only (+ avif, which the render
 * endpoint can produce via format=avif). imgproxy DOES pass sanitized SVG
 * through when no rasterizing transform applies, and format=origin can echo
 * whatever content-type the uploader claimed, so image/svg+xml, HTML, XML and
 * anything unknown is forced to `attachment`. This allowlist, `nosniff`, and
 * the locked-down CSP below are the real defense.
 */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * Transform failures split three ways: capability down → 503, missing object
 * → 404, everything else `[console:storage]`-prefixed → 400 user feedback.
 * The instanceof check MUST run before the prefix mapping — see the error
 * class docs in @/lib/console/storage.
 */
async function renderAttempt<T>(work: () => Promise<T>): Promise<T | Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof TransformUnavailableError) {
      return Response.json(
        { error: "Image transformations are unavailable" },
        { status: 503 },
      );
    }
    if (err instanceof Error && err.message.startsWith("[console:storage]")) {
      const message = err.message.replace(
        /^\[console:storage\] [\w-]+ failed: /,
        "",
      );
      return Response.json(
        { error: message },
        { status: message === "object not found" ? 404 : 400 },
      );
    }
    throw err;
  }
}

/**
 * Read transform params off the query string. Numbers parse via Number() so
 * garbage becomes NaN and fails loud in normalizeTransform; enum strings are
 * narrowed there too (the casts below are checked before any upstream call).
 * Empty params are treated as absent.
 */
function readTransformParams(params: URLSearchParams): TransformOptions {
  const options: TransformOptions = {};
  for (const key of ["width", "height", "quality"] as const) {
    const raw = params.get(key);
    if (raw) options[key] = Number(raw);
  }
  const resize = params.get("resize");
  if (resize) options.resize = resize as TransformOptions["resize"];
  const format = params.get("format");
  if (format) options.format = format as TransformOptions["format"];
  return options;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const bucket = url.searchParams.get("bucket") ?? CAMPAIGN_BUCKET;

  if (!isSafePath(path)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }
  if (!isSafeBucketName(bucket)) {
    return Response.json({ error: "invalid bucket name" }, { status: 400 });
  }
  if (!(await bucketExists(bucket))) {
    return Response.json({ error: "Bucket not found" }, { status: 404 });
  }

  const result = await renderAttempt(() => {
    // Clamp/validate here so bad params 400 before any upstream fetch.
    const options = normalizeTransform(readTransformParams(url.searchParams));
    // Forward Accept so the storage-api can auto-negotiate WebP.
    return fetchTransformedImage(
      bucket,
      path,
      options,
      req.headers.get("accept") ?? undefined,
    );
  });
  if (result instanceof Response) return result;

  const filename = path.split("/").pop() ?? "image";
  // Match on the media type alone (parameters like charset stripped) — a
  // parameterized raster type stays inline, anything else stays attachment.
  const essence = result.contentType.split(";")[0].trim().toLowerCase();
  const serveInline = INLINE_SAFE.has(essence);

  const headers = new Headers();
  headers.set("content-type", result.contentType);
  headers.set(
    "content-disposition",
    `${serveInline ? "inline" : "attachment"}; filename="${filename}"`,
  );
  // Never let the browser sniff a different (executable) type than we sent,
  // and sandbox anything that does render so stored SVG/HTML can't script
  // the app origin.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("cache-control", "private, no-store");

  return new Response(result.stream, { status: 200, headers });
}
