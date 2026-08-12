import { AuthError } from "@/lib/auth";
import { requireSectionApi } from "@/lib/requireSection";
import {
  TUS_FORWARD_REQUEST_HEADERS,
  TUS_FORWARD_RESPONSE_HEADERS,
  TUS_MAX_BYTES,
  TUS_UPSTREAM_PATH,
  isSafeBucketName,
  isSafePath,
} from "@/lib/console/storage";

/**
 * TUS resumable-upload proxy, gated on the platform section:
 *
 * - POST    /api/console/storage/tus            → create an upload
 * - PATCH   /api/console/storage/tus/{uploadId} → append a chunk
 * - HEAD    /api/console/storage/tus/{uploadId} → resume offset
 * - DELETE  /api/console/storage/tus/{uploadId} → terminate
 * - OPTIONS /api/console/storage/tus            → capability discovery
 *
 * The Supabase host is on a private network the browser can never reach, so
 * this route relays the TUS protocol byte-for-byte with four hard rules:
 * the upstream URL is built ONLY from server env + the fixed TUS path + path
 * segments validated as opaque tokens (never a client-supplied URL); ONLY the
 * allowlisted TUS headers cross in either direction (never cookies, never the
 * client's Authorization — the service key is injected here); the creation
 * `location` is rewritten back to THIS proxy so the browser keeps talking to
 * us, never to the internal upstream; and the creation Upload-Metadata's
 * bucketName/objectName must pass the same isSafeBucketName/isSafePath rules
 * as every other console route — the Storage API accepts far looser keys,
 * which would create objects the console can list but never manage.
 */

export const dynamic = "force-dynamic";

/** Where the browser talks to us — creation `location`s are rewritten here. */
const PROXY_PATH = "/api/console/storage/tus";

/**
 * Upload ids are opaque tokens (Supabase emits unpadded base64url). Slashes
 * arrive as separate catch-all segments; each one must match this shape, so
 * traversal (`.`/`..`), scheme separators, and percent-tricks can never reach
 * the upstream URL.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._~=-]{1,2048}$/;
const MAX_SEGMENTS = 8;

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== "." && !segment.includes("..");
}

/**
 * TUS Upload-Metadata: comma-separated `key` or `key <base64value>` pairs
 * (RFC 4648 standard base64). Returns null on malformed input — empty or
 * duplicate keys, extra spaces, or a value that is not base64.
 */
const BASE64_VALUE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseUploadMetadata(header: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const pair of header.split(",")) {
    const [key, encoded, extra] = pair.trim().split(" ");
    if (!key || extra !== undefined || out.has(key)) return null;
    if (encoded === undefined) {
      out.set(key, "");
      continue;
    }
    if (!BASE64_VALUE.test(encoded)) return null;
    out.set(key, Buffer.from(encoded, "base64").toString("utf8"));
  }
  return out;
}

/** Route context: `[[...id]]` — absent on create, id segments otherwise. */
interface Ctx {
  params: Promise<{ id?: string[] }>;
}

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** Fail-loud env read — this route never uses the supabase-js client. */
function requireEnv(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`[console:storage] tus failed: missing server env ${name}`);
  return value;
}

/** Only the allowlisted TUS request headers cross; the service key is ours. */
function upstreamHeaders(req: Request, serviceKey: string): Headers {
  const headers = new Headers();
  for (const name of TUS_FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${serviceKey}`);
  headers.set("apikey", serviceKey);
  return headers;
}

/**
 * Rewrite the upstream `location` (absolute or path-only) to this proxy.
 * Returns null when the upload id after the TUS prefix is not a safe token —
 * the caller answers 502 rather than relaying an internal URL.
 */
function rewriteLocation(location: string, upstreamBase: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(location, upstreamBase).pathname;
  } catch {
    return null;
  }
  const at = pathname.indexOf(TUS_UPSTREAM_PATH);
  const suffix =
    at >= 0
      ? pathname.slice(at + TUS_UPSTREAM_PATH.length)
      : pathname.slice(pathname.lastIndexOf("/"));
  const segments: string[] = [];
  for (const raw of suffix.split("/")) {
    if (raw.length === 0) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!isSafeSegment(decoded)) return null;
    segments.push(decoded);
  }
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  return `${PROXY_PATH}/${segments.map(encodeURIComponent).join("/")}`;
}

/** Statuses the Response constructor refuses to pair with a body. */
const NO_BODY_STATUS = new Set([204, 205, 304]);

type Method = "POST" | "PATCH" | "HEAD" | "DELETE" | "OPTIONS";

async function proxy(req: Request, ctx: Ctx, method: Method): Promise<Response> {
  try {
    await requireSectionApi(req.headers, "platform");
  } catch (err) {
    return authErrorResponse(err);
  }

  const segments = (await ctx.params).id ?? [];
  if (segments.length > MAX_SEGMENTS || !segments.every(isSafeSegment)) {
    return Response.json({ error: "invalid upload id" }, { status: 400 });
  }
  if ((method === "PATCH" || method === "HEAD" || method === "DELETE") && segments.length === 0) {
    return Response.json({ error: "upload id required" }, { status: 400 });
  }

  // Creation is where the total size is declared — enforce the proxy cap
  // here (chunk PATCHes stream through; upstream rejects offset overruns).
  // Upload-Defer-Length is thereby refused too: an undeclared length could
  // never be capped.
  if (method === "POST") {
    const uploadLength = req.headers.get("upload-length");
    if (
      uploadLength === null ||
      !/^\d+$/.test(uploadLength) ||
      Number(uploadLength) > TUS_MAX_BYTES
    ) {
      return Response.json(
        { error: `Upload-Length is required and must be 0 – ${TUS_MAX_BYTES} bytes` },
        { status: 413 },
      );
    }

    // Creation also names the object — hold bucketName/objectName to the same
    // rules as every other console route, or the upload creates an object the
    // console can list but never download/rename/delete (those routes 400 it).
    const rawMetadata = req.headers.get("upload-metadata");
    if (rawMetadata !== null) {
      const metadata = parseUploadMetadata(rawMetadata);
      const bucketName = metadata?.get("bucketName");
      const objectName = metadata?.get("objectName");
      if (
        metadata === null ||
        (bucketName !== undefined && !isSafeBucketName(bucketName)) ||
        (objectName !== undefined && !isSafePath(objectName))
      ) {
        return Response.json(
          { error: "invalid bucket or object name in upload-metadata" },
          { status: 400 },
        );
      }
    }
  }

  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const url =
    base +
    TUS_UPSTREAM_PATH +
    (segments.length > 0 ? `/${segments.map(encodeURIComponent).join("/")}` : "");

  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: upstreamHeaders(req, requireEnv("SUPABASE_SERVICE_ROLE_KEY")),
    // A proxy never follows redirects — a 3xx relays (and its location must
    // survive the rewrite below), so the service key can't chase a hop away.
    redirect: "manual",
  };
  // PATCH bodies are opaque chunk bytes — stream them through untouched.
  if ((method === "POST" || method === "PATCH") && req.body) {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return Response.json({ error: "storage upstream unreachable" }, { status: 502 });
  }

  const headers = new Headers();
  for (const name of TUS_FORWARD_RESPONSE_HEADERS) {
    let value = upstream.headers.get(name);
    if (value === null) continue;
    if (name === "location") {
      const rewritten = rewriteLocation(value, base);
      if (rewritten === null) {
        return Response.json(
          { error: "unexpected upstream upload location" },
          { status: 502 },
        );
      }
      value = rewritten;
    }
    // Never advertise more than the proxy will accept at creation.
    if (name === "tus-max-size" && /^\d+$/.test(value) && Number(value) > TUS_MAX_BYTES) {
      value = String(TUS_MAX_BYTES);
    }
    headers.set(name, value);
  }

  const body =
    method === "HEAD" || NO_BODY_STATUS.has(upstream.status) ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, ctx, "POST");
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, ctx, "PATCH");
}

export async function HEAD(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, ctx, "HEAD");
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, ctx, "DELETE");
}

export async function OPTIONS(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, ctx, "OPTIONS");
}
