/**
 * Client-safe mirrors of the TUS upload constants and the object-path rule
 * from @/lib/console/storage. That lib is `server-only` (it wraps the
 * service-role client), so client bundles cannot import it — the values here
 * MUST stay in sync with it, and resumable.test.ts asserts that they do.
 */

/** The Next proxy route in front of /storage/v1/upload/resumable. */
export const RESUMABLE_ENDPOINT = "/api/console/storage/tus";

/** = TUS_CHUNK_BYTES — Supabase mandates exactly 6MB TUS chunks. */
export const RESUMABLE_CHUNK_BYTES = 6 * 1024 * 1024;

/** = TUS_MAX_BYTES — the proxy 413s above this; enforce it before upload. */
export const RESUMABLE_MAX_BYTES = 1024 * 1024 * 1024;

/** Retry backoff for transient TUS failures (tus-js-client schedule). */
export const RESUMABLE_RETRY_DELAYS: number[] = [0, 1000, 3000, 5000];

/** Object keys: word chars, dot, dash, slash, space — no traversal. */
const SAFE_PATH = /^[A-Za-z0-9 ._\-/]+$/;

/** Mirror of isSafePath in @/lib/console/storage — keep byte-for-byte in sync. */
export function isSafeObjectPath(path: string): boolean {
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
 * The target object key for an upload: current folder prefix + the file's own
 * name. Returns null when the joined key fails the path rule — the caller must
 * refuse the file rather than mangle its name.
 */
export function buildObjectName(prefix: string, fileName: string): string | null {
  const cleanPrefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  const key = cleanPrefix ? `${cleanPrefix}/${fileName}` : fileName;
  return isSafeObjectPath(key) ? key : null;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
