// @vitest-environment node
// The route calls the verified (jose ES256) auth path; node env avoids the
// jsdom cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
} from "@/lib/__test__/albToken";

const h = vi.hoisted(() => ({
  listInstalledExtensions: vi.fn(),
  enableExtension: vi.fn(),
  dropExtension: vi.fn(),
}));

vi.mock("@/lib/console/dbobjects", () => ({
  listInstalledExtensions: h.listInstalledExtensions,
  enableExtension: h.enableExtension,
  dropExtension: h.dropExtension,
}));

import { DELETE, GET, POST } from "./route";

const EXTENSIONS = [
  {
    name: "pg_cron",
    schema: "pg_catalog",
    default_version: "1.6",
    installed_version: "1.6",
    comment: "Job scheduler for PostgreSQL",
  },
  {
    name: "postgis",
    schema: null,
    default_version: "3.4.0",
    installed_version: null,
    comment: "PostGIS geometry and geography spatial types and functions",
  },
];

let marketingToken: string;
let viewersToken: string;

beforeAll(async () => {
  await initAlbKeys();
  marketingToken = await signAlbToken({
    email: "amy@nsight.example",
    name: "Amy",
    "cognito:groups": ["marketing"],
  });
  viewersToken = await signAlbToken({
    email: "bob@nsight.example",
    "cognito:groups": ["viewers"],
  });
});

beforeEach(() => {
  setAlbEnv();
  installAlbKeyFetch();
  for (const fn of Object.values(h)) fn.mockReset();
  h.listInstalledExtensions.mockResolvedValue(EXTENSIONS);
  h.enableExtension.mockResolvedValue(undefined);
  h.dropExtension.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAlbEnv();
});

function req(
  method: string,
  body?: unknown,
  token: string | null = marketingToken,
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-amzn-oidc-data"] = token;
  return new Request("http://x/api/console/extensions", {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
}

describe("GET /api/console/extensions", () => {
  test("401/403 before anything runs", async () => {
    expect((await GET(req("GET", undefined, null))).status).toBe(401);
    expect((await GET(req("GET", undefined, viewersToken))).status).toBe(403);
    expect(h.listInstalledExtensions).not.toHaveBeenCalled();
  });

  test("returns the joined extension list for the marketing group", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ extensions: EXTENSIONS });
    expect(h.listInstalledExtensions).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/console/extensions (enable)", () => {
  test("401/403 before enabling anything", async () => {
    expect((await POST(req("POST", { name: "postgis" }, null))).status).toBe(401);
    expect(
      (await POST(req("POST", { name: "postgis" }, viewersToken))).status,
    ).toBe(403);
    expect(h.enableExtension).not.toHaveBeenCalled();
  });

  test("enables the extension and returns 201", async () => {
    const res = await POST(req("POST", { name: "postgis" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ enabled: "postgis" });
    expect(h.enableExtension).toHaveBeenCalledWith("postgis", {
      schema: undefined,
      version: undefined,
    });
  });

  test("passes an optional target schema/version through to the lib", async () => {
    await POST(req("POST", { name: "vector", schema: "extensions", version: "0.8.0" }));
    expect(h.enableExtension).toHaveBeenCalledWith("vector", {
      schema: "extensions",
      version: "0.8.0",
    });
  });

  test("400 on a missing name or malformed JSON", async () => {
    expect((await POST(req("POST", {}))).status).toBe(400);
    expect((await POST(req("POST", "{nope"))).status).toBe(400);
    expect(h.enableExtension).not.toHaveBeenCalled();
  });

  test("maps a [console:dbobjects] failure to 400 with the real message", async () => {
    h.enableExtension.mockRejectedValue(
      new Error("[console:dbobjects] enable-extension failed: unknown extension: nope"),
    );
    const res = await POST(req("POST", { name: "nope" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown extension: nope");
  });
});

describe("DELETE /api/console/extensions (drop)", () => {
  test("401/403 before dropping anything", async () => {
    expect((await DELETE(req("DELETE", { name: "pg_cron" }, null))).status).toBe(401);
    expect(
      (await DELETE(req("DELETE", { name: "pg_cron" }, viewersToken))).status,
    ).toBe(403);
    expect(h.dropExtension).not.toHaveBeenCalled();
  });

  test("drops the extension and returns it", async () => {
    const res = await DELETE(req("DELETE", { name: "pg_cron" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dropped: "pg_cron" });
    expect(h.dropExtension).toHaveBeenCalledWith("pg_cron");
  });

  test("400 on a missing name", async () => {
    expect((await DELETE(req("DELETE", {}))).status).toBe(400);
    expect(h.dropExtension).not.toHaveBeenCalled();
  });

  test("maps a [console:dbobjects] failure to 400 with the real message", async () => {
    h.dropExtension.mockRejectedValue(
      new Error("[console:dbobjects] drop-extension failed: extension pg_cron is not installed"),
    );
    const res = await DELETE(req("DELETE", { name: "pg_cron" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("extension pg_cron is not installed");
  });
});
