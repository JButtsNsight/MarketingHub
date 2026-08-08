import { describe, expect, test } from "vitest";

// The server-only lib is importable under vitest (the config aliases
// `server-only` to a no-op) — the parity tests below are what keep the
// client-safe mirrors honest.
import { TUS_CHUNK_BYTES, TUS_MAX_BYTES, isSafePath } from "@/lib/console/storage";

import {
  RESUMABLE_CHUNK_BYTES,
  RESUMABLE_ENDPOINT,
  RESUMABLE_MAX_BYTES,
  buildObjectName,
  formatBytes,
  isSafeObjectPath,
} from "./resumable";

describe("resumable constants", () => {
  test("mirror the server lib's TUS constants exactly", () => {
    expect(RESUMABLE_CHUNK_BYTES).toBe(TUS_CHUNK_BYTES);
    expect(RESUMABLE_MAX_BYTES).toBe(TUS_MAX_BYTES);
  });

  test("target the local proxy route, not Supabase", () => {
    expect(RESUMABLE_ENDPOINT).toBe("/api/console/storage/tus");
  });
});

describe("isSafeObjectPath", () => {
  const vectors = [
    "a.png",
    "brand/logo 2.png",
    "deep/nested/dir/file_name-v2.tar.gz",
    "../etc/passwd",
    "a..b",
    "/leading.png",
    "trailing/",
    "bad%name.bin",
    "emoji-🙂.png",
    "",
    "a".repeat(1025),
  ];

  test.each(vectors)("agrees with the server lib's isSafePath for %j", (path) => {
    expect(isSafeObjectPath(path)).toBe(isSafePath(path));
  });
});

describe("buildObjectName", () => {
  test("root uploads use the bare file name", () => {
    expect(buildObjectName("", "logo.png")).toBe("logo.png");
  });

  test("joins the current prefix and the file name", () => {
    expect(buildObjectName("brand/logos", "logo.png")).toBe("brand/logos/logo.png");
  });

  test("tolerates stray slashes around the prefix", () => {
    expect(buildObjectName("/brand/", "logo.png")).toBe("brand/logo.png");
  });

  test("returns null instead of mangling an unsafe name", () => {
    expect(buildObjectName("brand", "we?ird.png")).toBeNull();
    expect(buildObjectName("brand", "../../escape.png")).toBeNull();
  });
});

describe("formatBytes", () => {
  test("formats across unit boundaries", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(6 * 1024 * 1024)).toBe("6.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});
