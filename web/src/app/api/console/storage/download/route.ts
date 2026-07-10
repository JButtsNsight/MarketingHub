import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { MARKETING_GROUP } from "@/lib/requireMarketingUser";
import { signObject } from "@/lib/console/storage";

export const dynamic = "force-dynamic";

/** Object keys are `<uuid>/<safe-filename>`: word chars, dot, dash, slash only. */
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

/**
 * Stream a campaign-templates object to the browser. The Supabase signed URL
 * points at the PRIVATE internal data API (unreachable from a browser), so this
 * server — which lives inside the VPC — fetches the bytes and proxies them,
 * keeping the internal host private. Gated on the `marketing` Cognito group.
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

  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (
    !path ||
    path.includes("..") ||
    path.startsWith("/") ||
    !SAFE_PATH.test(path)
  ) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  const signedUrl = await signObject(path);
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
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("cache-control", "private, no-store");

  return new NextResponse(upstream.body, { status: 200, headers });
}
