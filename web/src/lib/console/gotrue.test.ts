// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as gotrueModule from "./gotrue";
import {
  GoTrueUnavailableError,
  getSettings,
  getUser,
  gotrueHealth,
  listSsoProviders,
  listUsers,
  type ListUsersOptions,
} from "./gotrue";

const URL_BASE = "http://supabase.internal:8000";
const SERVICE_KEY = "service-role-key-for-tests";

type FetchMock = ReturnType<typeof mockFetch>;

function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  const fn = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers,
      }),
    ),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentUrl(fn: FetchMock, call = 0): URL {
  return new URL(String(fn.mock.calls[call][0]));
}

function sentRawUrl(fn: FetchMock, call = 0): string {
  return String(fn.mock.calls[call][0]);
}

function sentHeaders(fn: FetchMock, call = 0): Record<string, string> {
  return (fn.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;
}

const HEALTH_BODY = {
  version: "v2.186.0",
  name: "GoTrue",
  description: "GoTrue is a user registration and authentication API",
};

const LIST_USER = {
  id: "5f5e1f9d-6a3a-4d3e-9a51-1c2f3a4b5c6d",
  aud: "authenticated",
  role: "authenticated",
  email: "ada@nsight.com",
  app_metadata: { provider: "email" },
  user_metadata: { full_name: "Ada Lovelace" },
  identities: null, // list endpoint never eager-loads
  created_at: "2026-08-01T00:00:00Z",
  is_anonymous: false,
};

beforeEach(() => {
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("export surface — GET-only hard constraint", () => {
  test("the module exports NO mutation helpers", () => {
    // Wave 3-partial ships read-only views only. This is the enforcement:
    // any new export (create/invite/ban/delete/update/generateLink/...)
    // fails this test until it is deliberately reviewed.
    const runtimeExports = Object.keys(gotrueModule).sort();
    expect(runtimeExports).toEqual([
      "GoTrueUnavailableError",
      "getSettings",
      "getUser",
      "gotrueHealth",
      "listSsoProviders",
      "listUsers",
    ]);
  });
});

describe("transport", () => {
  test("sends GET with BOTH apikey and Bearer headers, no-store, under /auth/v1", async () => {
    const fn = mockFetch(200, HEALTH_BODY);
    await gotrueHealth();

    expect(fn).toHaveBeenCalledTimes(1);
    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(`${URL_BASE}/auth/v1/health`);

    const init = fn.mock.calls[0][1];
    // No method set → GET. The client must never issue anything else.
    expect(init?.method).toBeUndefined();
    expect(init?.cache).toBe("no-store");

    const headers = sentHeaders(fn);
    // Kong key-auth needs apikey; GoTrue's bearer regexp needs the
    // explicit Bearer header (the LUA fallback strips the prefix).
    expect(headers.apikey).toBe(SERVICE_KEY);
    expect(headers.authorization).toBe(`Bearer ${SERVICE_KEY}`);
    // Never sent: it switches GoTrue to the {code, message} error shape.
    const headerNames = Object.keys(headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("x-supabase-api-version");
  });

  test("missing SUPABASE_URL → GoTrueUnavailableError before any fetch", async () => {
    delete process.env.SUPABASE_URL;
    const fn = mockFetch(200, HEALTH_BODY);
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toMatch(
      /^\[console:gotrue\] gotrue unreachable: SUPABASE_URL/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  test("malformed SUPABASE_URL → static-detail GoTrueUnavailableError, never echoing the URL", async () => {
    // If this value reached fetch(), Node's URL-parse TypeError would embed
    // the full internal URL — and unavailable details travel to console
    // clients in 503 bodies. The refusal must be static and fetch-free.
    process.env.SUPABASE_URL = "http://kong host:8000";
    const fn = mockFetch(200, HEALTH_BODY);
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toBe(
      "[console:gotrue] gotrue unreachable: SUPABASE_URL is not a valid http(s) URL on this server",
    );
    expect((err as Error).message).not.toContain("kong host");
    expect(fn).not.toHaveBeenCalled();
  });

  test("non-http(s) SUPABASE_URL scheme is refused before any fetch, URL never echoed", async () => {
    // "kong:8000" parses as scheme "kong:" — fetch would reject it with a
    // TypeError of its own; refuse it here with the same static detail.
    process.env.SUPABASE_URL = "kong:8000";
    const fn = mockFetch(200, HEALTH_BODY);
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toContain("not a valid http(s) URL");
    expect((err as Error).message).not.toContain("kong:8000");
    expect(fn).not.toHaveBeenCalled();
  });

  test("missing SUPABASE_SERVICE_ROLE_KEY → GoTrueUnavailableError before any fetch", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const fn = mockFetch(200, HEALTH_BODY);
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(fn).not.toHaveBeenCalled();
  });

  test("network failure → GoTrueUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toContain("ECONNREFUSED");
  });

  test("timeout (AbortError) → GoTrueUnavailableError mentioning the timeout", async () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(abort)),
    );
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toMatch(/timed out after 30000 ms/);
  });

  test("a body-read failure mid-stream (undici 'terminated') → GoTrueUnavailableError", async () => {
    // 200 headers already passed through Kong, then the container dies while
    // streaming the body: res.text() rejects. That is GoTrue not answering —
    // it must classify as unavailable, never escape as an unhandled 500.
    const res = new Response("never delivered", { status: 200 });
    vi.spyOn(res, "text").mockRejectedValue(new TypeError("terminated"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res)),
    );
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toContain("terminated");
  });

  test("an abort during the body read maps to the timeout detail", async () => {
    // The 30s bound covers the body phase too, not just headers — a
    // trickling body otherwise rides undici's ~300s default, past Kong's 60s.
    const abort = new DOMException("This operation was aborted", "AbortError");
    const res = new Response("stalled", { status: 200 });
    vi.spyOn(res, "text").mockRejectedValue(abort);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(res)),
    );
    const err = await gotrueHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toMatch(/timed out after 30000 ms/);
  });

  test("Kong 502/503/504 (GoTrue down/wedged/slow) → GoTrueUnavailableError", async () => {
    for (const status of [502, 503, 504]) {
      mockFetch(status, "upstream unavailable");
      const err = await gotrueHealth().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GoTrueUnavailableError);
      expect((err as Error).message).toContain(String(status));
      vi.unstubAllGlobals();
    }
  });

  test("403 not_admin is a key-misconfig FAILURE with actionable copy, never unavailable", async () => {
    mockFetch(403, {
      code: 403,
      error_code: "not_admin",
      msg: "User not allowed",
    });
    const err = await listUsers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toMatch(
      /^\[console:gotrue\] list-users failed: 403 not_admin/,
    );
    expect((err as Error).message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // The key value itself must never leak into error text.
    expect((err as Error).message).not.toContain(SERVICE_KEY);
  });

  test("Kong 401 {message} (key-auth rejection) is a plain failure, not unavailable", async () => {
    mockFetch(401, { message: "No API key found in request" });
    const err = await listUsers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toBe(
      "[console:gotrue] list-users failed: 401 (kong): No API key found in request",
    );
  });

  test("GoTrue 401 no_authorization surfaces status + error_code + msg", async () => {
    mockFetch(401, {
      code: 401,
      error_code: "no_authorization",
      msg: "This endpoint requires a valid Bearer token",
    });
    await expect(listUsers()).rejects.toThrow(
      /list-users failed: 401 no_authorization: This endpoint requires/,
    );
  });

  test("404 under /auth/v1 is a real answer (route always enabled), never unavailable", async () => {
    mockFetch(404, {
      code: 404,
      error_code: "user_not_found",
      msg: "User not found",
    });
    const err = await getUser("5f5e1f9d-6a3a-4d3e-9a51-1c2f3a4b5c6d").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoTrueUnavailableError);
    expect((err as Error).message).toBe(
      "[console:gotrue] get-user failed: 404 user_not_found: User not found",
    );
  });

  test("unparseable response bodies fail loud with the op name", async () => {
    mockFetch(500, "<html>Internal Server Error</html>");
    await expect(gotrueHealth()).rejects.toThrow(
      /\[console:gotrue\] health failed: unparseable response \(500\)/,
    );
  });

  test("service key never appears in any error message", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => {
        mockFetch(400, { code: 400, error_code: "validation_failed", msg: "bad" });
        return listUsers();
      },
      () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.reject(new Error("socket hang up"))),
        );
        return getSettings();
      },
      () => {
        mockFetch(503, "down");
        return gotrueHealth();
      },
    ];
    for (const run of cases) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(SERVICE_KEY);
      vi.unstubAllGlobals();
    }
  });
});

describe("gotrueHealth", () => {
  test("returns only version and name", async () => {
    mockFetch(200, HEALTH_BODY);
    await expect(gotrueHealth()).resolves.toEqual({
      version: "v2.186.0",
      name: "GoTrue",
    });
  });

  test("missing version/name fails loud", async () => {
    mockFetch(200, { ok: true });
    await expect(gotrueHealth()).rejects.toThrow(
      /health failed: unexpected response shape/,
    );
  });
});

describe("listUsers", () => {
  test("defaults: page=1, per_page=50, sort=created_at desc (encoded as %20)", async () => {
    const fn = mockFetch(
      200,
      { users: [LIST_USER], aud: "authenticated" },
      { "X-Total-Count": "1" },
    );
    const result = await listUsers();

    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(`${URL_BASE}/auth/v1/admin/users`);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("created_at desc");
    expect(url.searchParams.get("filter")).toBeNull();
    // Canonical wire encoding: %20, never "+".
    expect(sentRawUrl(fn)).toContain("sort=created_at%20desc");
    expect(sentRawUrl(fn)).not.toContain("+");

    expect(result.users).toEqual([LIST_USER]);
    expect(result.total).toBe(1);
    // List rows are never eager-loaded — identities stays null, no factors.
    expect(result.users[0].identities).toBeNull();
    expect(result.users[0].factors).toBeUndefined();
  });

  test("passes page/perPage/filter/sort through; total from X-Total-Count", async () => {
    const fn = mockFetch(
      200,
      { users: [], aud: "authenticated" },
      { "X-Total-Count": "137" },
    );
    const result = await listUsers({
      page: 3,
      perPage: 25,
      filter: "ada",
      sort: "asc",
    });
    const url = sentUrl(fn);
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("per_page")).toBe("25");
    expect(url.searchParams.get("filter")).toBe("ada");
    expect(url.searchParams.get("sort")).toBe("created_at asc");
    expect(result.total).toBe(137);
  });

  test("blank/whitespace filter is omitted; long filter is capped at 200 chars", async () => {
    let fn = mockFetch(200, { users: [] }, { "X-Total-Count": "0" });
    await listUsers({ filter: "   " });
    expect(sentUrl(fn).searchParams.get("filter")).toBeNull();
    vi.unstubAllGlobals();

    fn = mockFetch(200, { users: [] }, { "X-Total-Count": "0" });
    await listUsers({ filter: "a".repeat(250) });
    expect(sentUrl(fn).searchParams.get("filter")).toBe("a".repeat(200));
  });

  test("page and perPage clamp to sane integers", async () => {
    const cases: Array<[ListUsersOptions, string, string]> = [
      [{ page: 0, perPage: 0 }, "1", "1"],
      [{ page: -4, perPage: -1 }, "1", "1"],
      [{ page: 2.9, perPage: 12.7 }, "2", "12"],
      [{ perPage: 5000 }, "1", "100"],
    ];
    for (const [opts, page, perPage] of cases) {
      const fn = mockFetch(200, { users: [] }, { "X-Total-Count": "0" });
      await listUsers(opts);
      const url = sentUrl(fn);
      expect(url.searchParams.get("page")).toBe(page);
      expect(url.searchParams.get("per_page")).toBe(perPage);
      vi.unstubAllGlobals();
    }

    mockFetch(200, { users: [] });
    await expect(listUsers({ page: NaN })).rejects.toThrow(
      /page must be a finite number/,
    );
  });

  test("rejects sort values outside asc|desc without fetching", async () => {
    const fn = mockFetch(200, { users: [] });
    await expect(
      listUsers({ sort: "created_at; drop table users" as "asc" }),
    ).rejects.toThrow(/list-users failed: sort must be one of asc, desc/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("missing X-Total-Count falls back to the page row count", async () => {
    mockFetch(200, { users: [LIST_USER], aud: "authenticated" });
    const result = await listUsers();
    expect(result.total).toBe(1);
  });

  test("a body without a users array fails loud", async () => {
    mockFetch(200, { aud: "authenticated" });
    await expect(listUsers()).rejects.toThrow(
      /list-users failed: unexpected response shape: missing users array/,
    );
  });
});

describe("getUser", () => {
  const DETAIL_USER = {
    ...LIST_USER,
    identities: [
      {
        identity_id: "11111111-2222-3333-4444-555555555555",
        id: "ada@nsight.com",
        provider: "email",
        created_at: "2026-08-01T00:00:00Z",
        last_sign_in_at: "2026-08-07T10:00:00Z",
      },
    ],
    factors: [
      {
        id: "66666666-7777-8888-9999-000000000000",
        factor_type: "totp",
        status: "verified",
        friendly_name: "authenticator",
        created_at: "2026-08-02T00:00:00Z",
      },
    ],
  };

  test("fetches the eager-loaded user by id", async () => {
    const fn = mockFetch(200, DETAIL_USER);
    const user = await getUser(LIST_USER.id);
    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(
      `${URL_BASE}/auth/v1/admin/users/${LIST_USER.id}`,
    );
    expect(user.identities).toHaveLength(1);
    expect(user.factors).toHaveLength(1);
    expect(user.factors?.[0].factor_type).toBe("totp");
  });

  test("path-encodes hostile ids so they cannot traverse the path", async () => {
    const fn = mockFetch(404, {
      code: 404,
      error_code: "validation_failed",
      msg: "user_id must be an UUID",
    });
    await expect(getUser("../generate_link?x=/")).rejects.toThrow(
      /get-user failed: 404 validation_failed/,
    );
    const raw = sentRawUrl(fn);
    expect(raw).toBe(
      `${URL_BASE}/auth/v1/admin/users/..%2Fgenerate_link%3Fx%3D%2F`,
    );
  });

  test("empty/blank id is rejected without fetching", async () => {
    const fn = mockFetch(200, DETAIL_USER);
    await expect(getUser("")).rejects.toThrow(/get-user failed: id is required/);
    await expect(getUser("   ")).rejects.toThrow(/id is required/);
    expect(fn).not.toHaveBeenCalled();
  });

  test("a body without a user id fails loud", async () => {
    mockFetch(200, { unexpected: true });
    await expect(getUser(LIST_USER.id)).rejects.toThrow(
      /get-user failed: unexpected response shape: missing user id/,
    );
  });
});

describe("listSsoProviders", () => {
  test("unwraps {items} from /admin/sso/providers", async () => {
    const provider = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      resource_id: "nsight-workspace",
      disabled: false,
      saml: {
        entity_id: "https://accounts.google.com/o/saml2?idpid=C00n27oyt",
        metadata_url: "https://accounts.google.com/o/saml2/metadata",
      },
      domains: [{ domain: "nsight.com" }],
      created_at: "2026-08-01T00:00:00Z",
    };
    const fn = mockFetch(200, { items: [provider] });
    await expect(listSsoProviders()).resolves.toEqual([provider]);
    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(
      `${URL_BASE}/auth/v1/admin/sso/providers`,
    );
  });

  test("items:[] , items:null and absent items all normalize to []", async () => {
    // GoTrue answers items:[] normally, or null via its no-rows path —
    // the ~zero-providers reality today. Both must render the empty state.
    for (const body of [{ items: [] }, { items: null }, {}]) {
      mockFetch(200, body);
      await expect(listSsoProviders()).resolves.toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  test("non-object bodies and non-array items fail loud", async () => {
    mockFetch(200, "[]");
    await expect(listSsoProviders()).rejects.toThrow(
      /list-sso-providers failed: unexpected response shape/,
    );
    mockFetch(200, { items: "nope" });
    await expect(listSsoProviders()).rejects.toThrow(
      /items is not an array/,
    );
  });
});

describe("getSettings", () => {
  test("maps the /settings snapshot to the typed shape", async () => {
    const fn = mockFetch(200, {
      external: { email: true, google: false, phone: false },
      disable_signup: true,
      mailer_autoconfirm: false,
      phone_autoconfirm: false,
      sms_provider: "twilio",
      saml_enabled: false,
      external_labels: { should: "be ignored" },
    });
    await expect(getSettings()).resolves.toEqual({
      external: { email: true, google: false, phone: false },
      disable_signup: true,
      mailer_autoconfirm: false,
      phone_autoconfirm: false,
      sms_provider: "twilio",
      saml_enabled: false,
    });
    const url = sentUrl(fn);
    expect(url.origin + url.pathname).toBe(`${URL_BASE}/auth/v1/settings`);
  });

  test("non-boolean flag values coerce to false; missing sms_provider to ''", async () => {
    mockFetch(200, {
      external: { email: "yes", github: 1, google: true },
      disable_signup: "true",
      saml_enabled: null,
    });
    const settings = await getSettings();
    expect(settings.external).toEqual({
      email: false,
      github: false,
      google: true,
    });
    expect(settings.disable_signup).toBe(false);
    expect(settings.sms_provider).toBe("");
    expect(settings.saml_enabled).toBe(false);
  });

  test("missing external flags fail loud", async () => {
    mockFetch(200, { disable_signup: false });
    await expect(getSettings()).rejects.toThrow(
      /get-settings failed: unexpected response shape: missing external/,
    );
  });
});
