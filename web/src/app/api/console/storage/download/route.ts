import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { MARKETING_GROUP } from "@/lib/requireMarketingUser";
import {
  bucketExists,
  isSafePath,
  signObject,
  CAMPAIGN_BUCKET,
} from "@/lib/console/storage";

export const dynamic = "force-dynamic";

/**
 * Stream a Storage object to the browser. The Supabase signed URL points at
 * the PRIVATE internal data API (unreachable from a browser), so this server
 * — which lives inside the VPC — fetches the bytes and proxies them, keeping
 * the internal host private. Gated on the `marketing` Cognito group.
 *
 * `?bucket=` selects any live bucket (validated against listBuckets; default
 * stays campaign-templates for legacy links). `?inline=1` serves the bytes
 * inline — the preview path for images/PDFs in the Storage browser.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
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
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set(
    "content-disposition",
    `${inline ? "inline" : "attachment"}; filename="${filename}"`,
  );
  headers.set("cache-control", "private, no-store");

  return new NextResponse(upstream.body, { status: 200, headers });
}
