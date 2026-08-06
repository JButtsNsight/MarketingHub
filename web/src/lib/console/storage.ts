import "server-only";

import { getServiceClient } from "../supabase";

/** The app's original bucket — kept as the default for legacy callers. */
export const CAMPAIGN_BUCKET = "campaign-templates";

const SIGNED_URL_TTL = 60 * 5;

/** Uploads through the console are bounded (the ALB/WAF has its own caps). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

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

function fail(op: string, message: string): never {
  throw new Error(`[console:storage] ${op} failed: ${message}`);
}

export interface StorageBucket {
  id: string;
  name: string;
  public: boolean;
  createdAt: string | null;
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the bucket exists — the gate every object operation runs first. */
export async function bucketExists(bucket: string): Promise<boolean> {
  const buckets = await listBuckets();
  return buckets.some((b) => b.name === bucket);
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
