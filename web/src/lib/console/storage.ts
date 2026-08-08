import "server-only";

import { getServiceClient } from "../supabase";

/** The app's original bucket — kept as the default for legacy callers. */
export const CAMPAIGN_BUCKET = "campaign-templates";

const SIGNED_URL_TTL = 60 * 5;

/** Uploads through the console are bounded (the ALB/WAF has its own caps). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * TUS resumable-upload constants for the proxy route. The storage-api mounts
 * TUS unconditionally at this prefix (POST create, PATCH/HEAD/DELETE per
 * upload id). The proxy injects the service key itself, so client
 * Authorization/apikey headers must never be forwarded.
 */
export const TUS_UPSTREAM_PATH = "/storage/v1/upload/resumable";

/** Resumable uploads may exceed the classic 25MB cap, but stay bounded. */
export const TUS_MAX_BYTES = 1024 * 1024 * 1024;

/** Supabase requires exactly 6MB client chunks for TUS — do not change. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

/** Request headers a TUS proxy may forward upstream (lowercase). */
export const TUS_FORWARD_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "tus-resumable",
  "upload-length",
  "upload-offset",
  "upload-metadata",
  "upload-defer-length",
  "upload-checksum",
  "x-upsert",
];

/**
 * Response headers a TUS proxy may relay back (lowercase). `location` on the
 * creation response points at the upstream host — the proxy must rewrite it
 * to its own URL before relaying.
 */
export const TUS_FORWARD_RESPONSE_HEADERS: readonly string[] = [
  "tus-resumable",
  "tus-version",
  "tus-extension",
  "tus-max-size",
  "tus-checksum-algorithm",
  "upload-offset",
  "upload-length",
  "upload-expires",
  "upload-defer-length",
  "location",
  "cache-control",
];

/** Object keys: word chars, dot, dash, slash, space — no traversal. */
const SAFE_PATH = /^[A-Za-z0-9 ._\-/]+$/;

export function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.includes("..") &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    SAFE_PATH.test(path)
  );
}

/**
 * Bucket names: a URL-safe subset of upstream's S3-safe rules (upstream also
 * allows spaces and punctuation we don't want in console-built URLs).
 */
const SAFE_BUCKET = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export function isSafeBucketName(name: string): boolean {
  return SAFE_BUCKET.test(name) && !name.includes("..");
}

function fail(op: string, message: string): never {
  throw new Error(`[console:storage] ${op} failed: ${message}`);
}

export interface StorageBucket {
  id: string;
  name: string;
  public: boolean;
  createdAt: string | null;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

/** All buckets, name-sorted — the browser's bucket picker. */
export async function listBuckets(): Promise<StorageBucket[]> {
  const { data, error } = await getServiceClient().storage.listBuckets();
  if (error) fail("list-buckets", error.message);
  return (data ?? [])
    .map((b) => ({
      id: b.id,
      name: b.name,
      public: b.public ?? false,
      createdAt: b.created_at ?? null,
      fileSizeLimit: typeof b.file_size_limit === "number" ? b.file_size_limit : null,
      allowedMimeTypes: Array.isArray(b.allowed_mime_types)
        ? b.allowed_mime_types
        : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the bucket exists — the gate every object operation runs first. */
export async function bucketExists(bucket: string): Promise<boolean> {
  const buckets = await listBuckets();
  return buckets.some((b) => b.name === bucket);
}

/** Per-bucket size limits are bounded; the server's global cap still wins. */
export const BUCKET_SIZE_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024;

/** `type/subtype` or `type/*` wildcards, as the Storage API accepts. */
const SAFE_MIME = /^[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+)$/i;

export interface BucketOptions {
  public?: boolean;
  /** Bytes; null clears the per-bucket limit. */
  fileSizeLimit?: number | null;
  /** null clears the allow-list (all mime types accepted). */
  allowedMimeTypes?: string[] | null;
}

/** Reject malformed bucket settings before they reach the Storage API. */
function validateBucketInput(op: string, name: string, options: BucketOptions): void {
  if (!isSafeBucketName(name)) fail(op, `invalid bucket name "${name}"`);
  const { fileSizeLimit, allowedMimeTypes } = options;
  if (fileSizeLimit != null) {
    if (
      !Number.isInteger(fileSizeLimit) ||
      fileSizeLimit < 1 ||
      fileSizeLimit > BUCKET_SIZE_LIMIT_MAX_BYTES
    ) {
      fail(op, `fileSizeLimit must be an integer between 1 and ${BUCKET_SIZE_LIMIT_MAX_BYTES}`);
    }
  }
  if (allowedMimeTypes != null) {
    if (allowedMimeTypes.length === 0 || allowedMimeTypes.length > 64) {
      fail(op, "allowedMimeTypes must contain 1-64 entries (null clears the list)");
    }
    for (const mime of allowedMimeTypes) {
      if (typeof mime !== "string" || mime.length > 255 || !SAFE_MIME.test(mime)) {
        fail(op, `invalid mime type "${mime}"`);
      }
    }
  }
}

/** Create a bucket. Private by default, like Studio. */
export async function createBucket(
  name: string,
  options: BucketOptions = {},
): Promise<void> {
  validateBucketInput("create-bucket", name, options);
  const { error } = await getServiceClient().storage.createBucket(name, {
    public: options.public ?? false,
    fileSizeLimit: options.fileSizeLimit,
    allowedMimeTypes: options.allowedMimeTypes,
  });
  if (error) fail("create-bucket", error.message);
}

export interface BucketUpdate extends BucketOptions {
  /** The Storage API replaces visibility on every update — always explicit. */
  public: boolean;
}

/** Update bucket settings (visibility, size limit, mime allow-list). */
export async function updateBucket(name: string, options: BucketUpdate): Promise<void> {
  validateBucketInput("update-bucket", name, options);
  const { error } = await getServiceClient().storage.updateBucket(name, {
    public: options.public,
    fileSizeLimit: options.fileSizeLimit,
    allowedMimeTypes: options.allowedMimeTypes,
  });
  if (error) fail("update-bucket", error.message);
}

/** Delete a bucket — the Storage API refuses unless it is already empty. */
export async function deleteBucket(name: string): Promise<void> {
  if (!isSafeBucketName(name)) fail("delete-bucket", `invalid bucket name "${name}"`);
  const { error } = await getServiceClient().storage.deleteBucket(name);
  if (error) fail("delete-bucket", error.message);
}

/** Remove every object in a bucket (the bucket itself remains). */
export async function emptyBucket(name: string): Promise<void> {
  if (!isSafeBucketName(name)) fail("empty-bucket", `invalid bucket name "${name}"`);
  const { error } = await getServiceClient().storage.emptyBucket(name);
  if (error) fail("empty-bucket", error.message);
}

export interface StorageEntry {
  name: string;
  /** null id => a folder/prefix (Supabase lists nested keys as pseudo-folders). */
  isFolder: boolean;
  size: number | null;
  mimetype: string | null;
  updatedAt: string | null;
  /** Full object path (prefix + name), used for drill-down and signing. */
  path: string;
}

/**
 * List one level of `bucket` at `prefix` (pseudo-folders come back with a
 * null id, exactly how Studio renders the tree). Fail-loud on any Storage
 * API error.
 */
export async function listBucket(
  prefix = "",
  bucket: string = CAMPAIGN_BUCKET,
): Promise<StorageEntry[]> {
  const { data, error } = await getServiceClient()
    .storage.from(bucket)
    .list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) fail("list", error.message);

  return (data ?? []).map((obj) => {
    const meta = (obj.metadata ?? {}) as {
      size?: number;
      mimetype?: string;
    };
    const isFolder = obj.id == null;
    return {
      name: obj.name,
      isFolder,
      size: typeof meta.size === "number" ? meta.size : null,
      mimetype: typeof meta.mimetype === "string" ? meta.mimetype : null,
      updatedAt: obj.updated_at ?? null,
      path: prefix ? `${prefix}/${obj.name}` : obj.name,
    };
  });
}

/** A short-lived signed download URL for an object. Fail-loud. */
export async function signObject(
  path: string,
  bucket: string = CAMPAIGN_BUCKET,
): Promise<string> {
  const { data, error } = await getServiceClient()
    .storage.from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error) fail("sign", error.message);
  return (data as { signedUrl: string }).signedUrl;
}

/**
 * Upload one object. `upsert: false` — overwriting through the console must
 * be an explicit delete-then-upload, never a silent replace.
 */
export async function uploadObject(
  bucket: string,
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const { error } = await getServiceClient()
    .storage.from(bucket)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) fail("upload", error.message);
}

/** Delete objects by full path. Returns how many the API confirmed removed. */
export async function deleteObjects(
  bucket: string,
  paths: string[],
): Promise<number> {
  const { data, error } = await getServiceClient()
    .storage.from(bucket)
    .remove(paths);
  if (error) fail("delete", error.message);
  return (data ?? []).length;
}

/** Rename/move one object within its bucket. */
export async function moveObject(
  bucket: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  const { error } = await getServiceClient()
    .storage.from(bucket)
    .move(fromPath, toPath);
  if (error) fail("move", error.message);
}

/* ------------------------------ transforms ------------------------------ */

/** Server clamps to IMAGE_TRANSFORMATION_LIMIT_MIN/MAX_SIZE — mirror it. */
export const TRANSFORM_DIMENSION_MIN = 1;
export const TRANSFORM_DIMENSION_MAX = 2000;
export const TRANSFORM_QUALITY_MIN = 20;
export const TRANSFORM_QUALITY_MAX = 100;

const RESIZE_MODES = ["cover", "contain", "fill"] as const;
const FORMATS = ["origin", "avif"] as const;

export interface TransformOptions {
  width?: number;
  height?: number;
  resize?: (typeof RESIZE_MODES)[number];
  quality?: number;
  format?: (typeof FORMATS)[number];
}

/**
 * Transforms are a runtime capability of the storage-api (imgproxy sidecar);
 * routes map this to 503 instead of the 400 that `[console:storage]` errors
 * get. The message deliberately lacks that prefix so a generic attempt-helper
 * cannot misclassify it — check `instanceof` BEFORE the prefix check.
 */
export class TransformUnavailableError extends Error {
  constructor(detail: string) {
    super(`image transformations unavailable: ${detail}`);
    this.name = "TransformUnavailableError";
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Validate and clamp transform params to what the render endpoint accepts.
 * Invalid enums/non-numbers fail loud; out-of-range numbers clamp.
 */
export function normalizeTransform(options: TransformOptions): TransformOptions {
  const out: TransformOptions = {};
  for (const key of ["width", "height"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("render", `${key} must be a finite number`);
    }
    out[key] = clampInt(value, TRANSFORM_DIMENSION_MIN, TRANSFORM_DIMENSION_MAX);
  }
  if (options.quality !== undefined) {
    if (typeof options.quality !== "number" || !Number.isFinite(options.quality)) {
      fail("render", "quality must be a finite number");
    }
    out.quality = clampInt(options.quality, TRANSFORM_QUALITY_MIN, TRANSFORM_QUALITY_MAX);
  }
  if (options.resize !== undefined) {
    if (!RESIZE_MODES.includes(options.resize)) {
      fail("render", `resize must be one of ${RESIZE_MODES.join("|")}`);
    }
    out.resize = options.resize;
  }
  if (options.format !== undefined) {
    if (!FORMATS.includes(options.format)) {
      fail("render", `format must be one of ${FORMATS.join("|")}`);
    }
    out.format = options.format;
  }
  return out;
}

export interface TransformedImage {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  size: number | null;
}

/** Fail-loud env read — getServiceClient() holds these privately. */
function renderEnv(name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"): string {
  const value = process.env[name];
  if (!value) fail("render", `missing server env ${name}`);
  return value;
}

/**
 * Fetch a transformed object through the authenticated render endpoint with
 * the service key (the browser never reaches Supabase). Pass the client's
 * Accept header to let the server auto-negotiate WebP. Throws
 * TransformUnavailableError when the capability itself is down (routes not
 * registered / imgproxy unreachable) so routes can answer 503.
 */
export async function fetchTransformedImage(
  bucket: string,
  path: string,
  options: TransformOptions = {},
  accept?: string,
): Promise<TransformedImage> {
  if (!isSafeBucketName(bucket)) fail("render", `invalid bucket name "${bucket}"`);
  if (!isSafePath(path)) fail("render", "invalid object path");
  const normalized = normalizeTransform(options);

  const base = renderEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = renderEnv("SUPABASE_SERVICE_ROLE_KEY");
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(normalized)) params.set(k, String(v));
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const url =
    `${base}/storage/v1/render/image/authenticated/` +
    `${encodeURIComponent(bucket)}/${encodedPath}${query}`;

  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    apikey: key,
  };
  if (accept) headers.accept = accept;

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new TransformUnavailableError(
      `storage unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 5xx = imgproxy/storage processing failure; a Fastify "Route ... not
    // found" 404 = ENABLE_IMAGE_TRANSFORMATION is off (routes unregistered).
    if (res.status >= 500) {
      throw new TransformUnavailableError(`upstream ${res.status}`);
    }
    if (res.status === 404 && /"message"\s*:\s*"Route /.test(body)) {
      throw new TransformUnavailableError("render routes not registered");
    }
    if (res.status === 404) fail("render", "object not found");
    fail("render", `upstream ${res.status}: ${body.slice(0, 200)}`);
  }
  if (!res.body) fail("render", "empty response body");

  const length = res.headers.get("content-length");
  const size = length !== null && /^\d+$/.test(length) ? Number(length) : null;
  return {
    stream: res.body,
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    size,
  };
}
