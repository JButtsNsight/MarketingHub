// @vitest-environment node
// supabase is server-only and getUserClient mints jose HS256 JWTs; node env
// avoids the jsdom cross-realm Uint8Array mismatch that breaks WebCrypto.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppUser } from "./auth";

// vitest runs with cwd = web/
const SRC = resolve(process.cwd(), "src/lib/supabase.ts");

const USER: AppUser = {
  email: "jane.doe@nsightcare.com",
  name: "Jane Doe",
  groups: ["marketing"],
};

const JWT_SECRET = "test-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789";

const FALLBACK_WARNING =
  "[supabase] SUPABASE_JWT_SECRET unset — getUserClient() serving service-role client";

describe("lib/supabase server client", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_JWT_SECRET;
  });

  afterEach(() => {
    process.env = { ...OLD };
    vi.restoreAllMocks();
  });

  test("module is marked server-only", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/import\s+["']server-only["']/);
  });

  test("throws (fail-loud) when SUPABASE_URL is missing", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    const { getServiceClient } = await import("./supabase");
    expect(() => getServiceClient()).toThrow(/SUPABASE_URL/);
  });

  test("throws (fail-loud) when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    process.env.SUPABASE_URL = "https://mh.supabase.example.com";
    const { getServiceClient } = await import("./supabase");
    expect(() => getServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  test("returns a Supabase client when both env vars are set", async () => {
    process.env.SUPABASE_URL = "https://mh.supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    const { getServiceClient } = await import("./supabase");
    const client = getServiceClient();
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
    expect(client.storage).toBeDefined();
  });
});

describe("lib/supabase getUserClient (Wave-4 flag: SUPABASE_JWT_SECRET)", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://mh.supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.PREVIEW_AUTH;
  });

  afterEach(() => {
    process.env = { ...OLD };
    vi.restoreAllMocks();
  });

  test("flag unset ⇒ falls back to the EXACT memoized service-role client", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getUserClient, getServiceClient } = await import("./supabase");

    const client = await getUserClient(USER);
    // Byte-identical fallback: the SAME singleton the service path serves.
    expect(client).toBe(getServiceClient());
    expect(await getUserClient(USER)).toBe(getServiceClient());
  });

  test("flag unset ⇒ warns exactly ONCE with the contract message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getUserClient } = await import("./supabase");

    await getUserClient(USER);
    await getUserClient(USER);
    await getUserClient(USER);

    const fallbackWarns = warn.mock.calls.filter(
      (args) => args[0] === FALLBACK_WARNING,
    );
    expect(fallbackWarns).toHaveLength(1);
  });

  test("flag set ⇒ per-request client (never memoized, never the service singleton)", async () => {
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getUserClient, getServiceClient } = await import("./supabase");

    const a = await getUserClient(USER);
    const b = await getUserClient(USER);
    expect(a).not.toBe(b);
    expect(a).not.toBe(getServiceClient());
    expect(typeof a.from).toBe("function");
    // No fallback warning on the active path.
    expect(
      warn.mock.calls.filter((args) => args[0] === FALLBACK_WARNING),
    ).toHaveLength(0);
  });

  test("flag set ⇒ Authorization header carries a verifiable authenticated-role user JWT", async () => {
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    const { getUserClient } = await import("./supabase");
    const { subForEmail } = await import("./userJwt");

    const client = await getUserClient(USER);
    const headers = (client as unknown as { headers: Record<string, string> })
      .headers;

    const authorization = headers.Authorization;
    expect(authorization).toMatch(/^Bearer /);

    // The apikey header is NOT overridden here — supabase-js injects the
    // service-role key as `apikey` at request time (Kong key-auth needs a
    // known key); PostgREST takes the role from Authorization instead.
    expect(headers.apikey).toBeUndefined();

    const token = authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(JWT_SECRET),
      { algorithms: ["HS256"] },
    );
    expect(payload.role).toBe("authenticated");
    expect(payload.email).toBe(USER.email);
    expect(payload.sub).toBe(subForEmail(USER.email));
    expect(payload.app_metadata).toEqual({
      groups: ["marketing"],
      source: "alb-cognito",
    });
  });

  test("flag set ⇒ still fail-loud when the base Supabase env is missing", async () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
    const { getUserClient } = await import("./supabase");
    await expect(getUserClient(USER)).rejects.toThrow(/SUPABASE_URL/);
  });
});
