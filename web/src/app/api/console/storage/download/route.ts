import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  bucketExists,
  isSafePath,
  signObject,
  CAMPAIGN_BUCKET,
} from "@/lib/console/storage";

export const dynamic = "force-dynamic";

/**
 * Content types safe to serve INLINE from the app origin. Deliberately raster
 * images only: an inline SVG or HTML upload would execute its own script in
 * THIS origin — the same origin that drives the superuser SQL editor — so
 * those (and everything else) are forced to `attachment` regardless of the
 * caller's `?inline=1`. Object content-type is attacker-controlled (it comes
 * from the uploader's multipart part), so this allowlist, `nosniff`, and the
 * locked-down CSP below are the real defense, not the upload path.
 */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * Stream a Storage object to the browser. The Supabase signed URL points at
 * the PRIVATE internal data API (unreachable from a browser), so this server
 * — which lives inside the VPC — fetches the bytes and proxies them, keeping
 * the internal host private. Gated on the platform section.
 *
 * `?bucket=` selects any live bucket (validated against listBuckets; default
 * stays campaign-templates for legacy links). `?inline=1` requests inline
 * rendering — honored ONLY for allowlisted raster image types (see above).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  const bucket = url.searchParams.get("bucket") ?? CAMPAIGN_BUCKET;
  const inline = url.searchParams.get("inline") === "1";

  if (!isSafePath(path)) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }
  if (!(await bucketExists(bucket))) {
    return NextResponse.json({ error: "Bucket not found" }, { status: 404 });
  }

  const signedUrl = await signObject(path, bucket);
  const upstream = await fetch(signedUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `object fetch failed: ${upstream.status}` },
      { status: 502 },
    );
  }

  const filename = path.split("/").pop() ?? "download";
  const contentType = upstream.headers.get("content-type");
  // Inline only for allowlisted raster images; everything else downloads.
  const serveInline = inline && contentType != null && INLINE_SAFE.has(contentType);

  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  headers.set(
    "content-disposition",
    `${serveInline ? "inline" : "attachment"}; filename="${filename}"`,
  );
  // Never let the browser sniff a different (executable) type than we sent,
  // and sandbox anything that does render so stored SVG/HTML can't script the
  // app origin.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  headers.set("cache-control", "private, no-store");

  return new NextResponse(upstream.body, { status: 200, headers });
}
