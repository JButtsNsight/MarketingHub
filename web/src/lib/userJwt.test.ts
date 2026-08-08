// @vitest-environment node
// userJwt is server-only (jose HS256 sign/verify); node env avoids the jsdom
// cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { decodeProtectedHeader, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppUser } from "./auth";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/userJwt.ts");

const SECRET = "test-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const KEY = new TextEncoder().encode(SECRET);

const USER: AppUser = {
  email: "Jane.Doe@NsightCare.com",
  name: "Jane Doe",
  groups: ["marketing", "admin"],
};

/** UUIDv5(DNS namespace, name) vectors computed with Python's uuid.uuid5. */
const V5_WWW_EXAMPLE_COM = "2ed6657d-e927-568b-95e1-2665a8aea6a2";
const V5_JANE_LOWER = "2adce080-8b98-5721-8d0a-2e8a128aab81";
const V5_PREVIEW = "acccf165-442b-511c-bedd-16dcdb8c745a";

async function importFresh() {
  vi.resetModules();
  return await import("./userJwt");
}

describe("lib/userJwt", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.PREVIEW_AUTH;
  });

  afterEach(() => {
    process.env = { ...OLD };
    vi.useRealTimers();
  });

  test("module is marked server-only (secret can never ship in a client bundle)", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  describe("subForEmail", () => {
    test("matches the canonical UUIDv5/DNS-namespace vector", async () => {
      const { subForEmail } = await importFresh();
      expect(subForEmail("www.example.com")).toBe(V5_WWW_EXAMPLE_COM);
    });

    test("is deterministic and case-insensitive (lowercases the email)", async () => {
      const { subForEmail } = await importFresh();
      expect(subForEmail("Jane.Doe@NsightCare.com")).toBe(V5_JANE_LOWER);
      expect(subForEmail("jane.doe@nsightcare.com")).toBe(V5_JANE_LOWER);
      expect(subForEmail("JANE.DOE@NSIGHTCARE.COM")).toBe(V5_JANE_LOWER);
      expect(subForEmail("preview@nsightcare.com")).toBe(V5_PREVIEW);
    });

    test("emits a well-formed version-5, RFC-4122-variant UUID", async () => {
      const { subForEmail } = await importFresh();
      expect(subForEmail("someone@example.org")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("mintUserJwt", () => {
    test("throws (fail-loud) when SUPABASE_JWT_SECRET is unset", async () => {
      const { mintUserJwt } = await importFresh();
      await expect(mintUserJwt(USER)).rejects.toThrow(/SUPABASE_JWT_SECRET/);
    });

    test("mint/verify round-trip carries the full contract claim set (ALB source)", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const { mintUserJwt, subForEmail, DEFAULT_TTL_SECONDS } =
        await importFresh();

      const token = await mintUserJwt(USER);

      expect(decodeProtectedHeader(token)).toMatchObject({
        alg: "HS256",
        typ: "JWT",
      });

      const { payload } = await jwtVerify(token, KEY, {
        algorithms: ["HS256"],
      });
      expect(payload.role).toBe("authenticated");
      expect(payload.sub).toBe(subForEmail(USER.email));
      expect(payload.sub).toBe(V5_JANE_LOWER);
      expect(payload.email).toBe(USER.email);
      expect(payload.groups).toEqual(["marketing", "admin"]);
      expect(payload.app_metadata).toEqual({
        groups: ["marketing", "admin"],
        source: "alb-cognito",
      });
      expect(payload.iss).toBe("supabase");
      expect(payload.aud).toBe("authenticated");
      expect(typeof payload.iat).toBe("number");
      expect(payload.exp).toBe((payload.iat as number) + DEFAULT_TTL_SECONDS);
    });

    test("app_metadata.source flips to 'preview' when PREVIEW_AUTH is set", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      process.env.PREVIEW_AUTH = "marketing";
      const { mintUserJwt } = await importFresh();

      // The PREVIEW_AUTH stub identity from lib/auth.ts getUser().
      const preview: AppUser = {
        email: "preview@nsightcare.com",
        name: "Preview User",
        groups: ["marketing"],
      };
      const token = await mintUserJwt(preview);
      const { payload } = await jwtVerify(token, KEY, {
        algorithms: ["HS256"],
      });
      expect(payload.sub).toBe(V5_PREVIEW);
      expect(payload.app_metadata).toEqual({
        groups: ["marketing"],
        source: "preview",
      });
      expect(payload.role).toBe("authenticated");
    });

    test("role is module-enforced — an injected role property can never win", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const { mintUserJwt } = await importFresh();

      const hostile = {
        ...USER,
        role: "service_role",
        sub: "not-a-real-sub",
      } as unknown as AppUser;
      const token = await mintUserJwt(hostile);
      const { payload } = await jwtVerify(token, KEY, {
        algorithms: ["HS256"],
      });
      expect(payload.role).toBe("authenticated");
      expect(payload.sub).toBe(V5_JANE_LOWER);
    });

    test("honours ttlSeconds and clamps nothing silently — out-of-range throws", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const {
        mintUserJwt,
        DEFAULT_TTL_SECONDS,
        MAX_TTL_SECONDS,
        MIN_TTL_SECONDS,
      } = await importFresh();

      expect(DEFAULT_TTL_SECONDS).toBe(300);
      expect(MAX_TTL_SECONDS).toBe(900);
      expect(MIN_TTL_SECONDS).toBe(60);

      const token = await mintUserJwt(USER, { ttlSeconds: 600 });
      const { payload } = await jwtVerify(token, KEY, {
        algorithms: ["HS256"],
      });
      expect(payload.exp).toBe((payload.iat as number) + 600);

      // Bounds are inclusive.
      await expect(
        mintUserJwt(USER, { ttlSeconds: MIN_TTL_SECONDS }),
      ).resolves.toBeTypeOf("string");
      await expect(
        mintUserJwt(USER, { ttlSeconds: MAX_TTL_SECONDS }),
      ).resolves.toBeTypeOf("string");

      // Clock-skew guard: below the 60s floor (2x PostgREST's 30s skew) throws.
      await expect(mintUserJwt(USER, { ttlSeconds: 59 })).rejects.toThrow(
        RangeError,
      );
      await expect(mintUserJwt(USER, { ttlSeconds: 0 })).rejects.toThrow(
        RangeError,
      );
      await expect(mintUserJwt(USER, { ttlSeconds: 901 })).rejects.toThrow(
        RangeError,
      );
      await expect(mintUserJwt(USER, { ttlSeconds: NaN })).rejects.toThrow(
        RangeError,
      );
    });

    test("exp is anchored to iat (single clock read — skew-safe arithmetic)", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
      const { mintUserJwt } = await importFresh();

      const token = await mintUserJwt(USER);
      const { payload } = await jwtVerify(token, KEY, {
        algorithms: ["HS256"],
        currentDate: new Date("2026-08-08T12:00:00Z"),
      });
      const expectedIat = Math.floor(
        new Date("2026-08-08T12:00:00Z").getTime() / 1000,
      );
      expect(payload.iat).toBe(expectedIat);
      expect(payload.exp).toBe(expectedIat + 300);
    });
  });

  describe("verifyUserJwt", () => {
    test("round-trips a minted token with HS256 pinned", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const { mintUserJwt, verifyUserJwt } = await importFresh();

      const token = await mintUserJwt(USER);
      const payload = await verifyUserJwt(token);
      expect(payload.role).toBe("authenticated");
      expect(payload.email).toBe(USER.email);
    });

    test("rejects a token signed with a different secret", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const { mintUserJwt } = await importFresh();
      const token = await mintUserJwt(USER);

      process.env.SUPABASE_JWT_SECRET = "a-completely-different-secret-value";
      const { verifyUserJwt } = await importFresh();
      await expect(verifyUserJwt(token)).rejects.toThrow();
    });

    test("rejects a tampered token", async () => {
      process.env.SUPABASE_JWT_SECRET = SECRET;
      const { mintUserJwt, verifyUserJwt } = await importFresh();

      const token = await mintUserJwt(USER);
      const [header, payload, sig] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
          role: "service_role",
        }),
        "utf8",
      ).toString("base64url");
      await expect(
        verifyUserJwt(`${header}.${forged}.${sig}`),
      ).rejects.toThrow();
    });
  });
});
