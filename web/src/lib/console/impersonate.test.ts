// @vitest-environment node
// impersonate mints real HS256 tokens through lib/userJwt (jose sign/verify);
// node env avoids the jsdom cross-realm Uint8Array mismatch in WebCrypto.
import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
  serviceClient: null as unknown,
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: h.createClient }));
vi.mock("../supabase", () => ({ getServiceClient: () => h.serviceClient }));

import { subForEmail } from "../userJwt";
import {
  ImpersonationAuditError,
  runImpersonatedQuery,
  type ImpersonationQueryOptions,
} from "./impersonate";

const SECRET = "test-jwt-secret-abcdefghijklmnopqrstuvwxyz-0123456789";
const KEY = new TextEncoder().encode(SECRET);
const SERVICE_KEY = "service-role-key-for-tests";

const BASE_OPTS: ImpersonationQueryOptions = {
  email: "Target@Example.com",
  groups: ["marketing"],
  ttlSeconds: 120,
  schema: "marketinghub",
  table: "templates",
  limit: 5,
};

type SelectResult = { data: unknown; error: { message: string } | null };
const ok = (data: unknown): SelectResult => ({ data, error: null });

/** One-off user client mock: records the select chain, resolves `result`. */
function buildUserClient(result: SelectResult) {
  const calls = { schema: "", table: "", select: "", limit: 0 };
  const client = {
    schema(s: string) {
      calls.schema = s;
      return {
        from(t: string) {
          calls.table = t;
          return {
            select(cols: string) {
              calls.select = cols;
              return {
                limit(n: number) {
                  calls.limit = n;
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

/** Service client mock: serves the comparison select AND the audit insert. */
function buildServiceClient(
  selectResult: SelectResult,
  auditResult: { error: { message: string } | null } = { error: null },
) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const selects: Array<{ table: string; limit: number }> = [];
  const client = {
    schema: () => ({
      from: (table: string) => ({
        select: () => ({
          limit: (n: number) => {
            selects.push({ table, limit: n });
            return Promise.resolve(selectResult);
          },
        }),
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve(auditResult);
        },
      }),
    }),
  };
  return { client, inserts, selects };
}

/** Wire the createClient mock, capturing the one-off client's construction. */
function installUserClient(result: SelectResult) {
  const built = buildUserClient(result);
  const captured = { url: "", apikey: "", authorization: "", options: null as unknown };
  h.createClient.mockImplementation(
    (url: string, key: string, options: Record<string, unknown>) => {
      captured.url = url;
      captured.apikey = key;
      captured.options = options;
      const global = options?.global as
        | { headers?: Record<string, string> }
        | undefined;
      captured.authorization = global?.headers?.Authorization ?? "";
      return built.client;
    },
  );
  return { ...built, captured };
}

describe("lib/console/impersonate", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    h.createClient.mockReset();
    h.serviceClient = null;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    process.env.SUPABASE_URL = "http://kong.internal:8000";
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    delete process.env.PREVIEW_AUTH;
  });

  afterEach(() => {
    process.env = { ...OLD };
    vi.restoreAllMocks();
  });

  test("mints a bounded authenticated token, runs both selects, audits the run", async () => {
    const user = installUserClient(ok([{ id: "r1", name: "a" }]));
    const service = buildServiceClient(ok([{ id: "r1" }, { id: "r2" }]));
    h.serviceClient = service.client;

    const result = await runImpersonatedQuery("amy@nsight.example", BASE_OPTS);

    // Claims: role clamped to the literal, sub deterministic, exp bounded.
    expect(result.claims.role).toBe("authenticated");
    expect(result.claims.sub).toBe(subForEmail("target@example.com"));
    expect(result.claims.email).toBe("Target@Example.com");
    expect(
      (result.claims.exp as number) - (result.claims.iat as number),
    ).toBe(120);

    // One-off client per §2 shape: service key as apikey, JWT in Authorization.
    expect(user.captured.url).toBe("http://kong.internal:8000");
    expect(user.captured.apikey).toBe(SERVICE_KEY);
    const token = user.captured.authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"] });
    expect(payload.role).toBe("authenticated");

    // The requested select ran as the impersonated identity…
    expect(user.calls).toEqual({
      schema: "marketinghub",
      table: "templates",
      select: "*",
      limit: 5,
    });
    expect(result.rowCount).toBe(1);
    expect(result.rows).toEqual([{ id: "r1", name: "a" }]);

    // …and the same select ran as service_role for the comparison panel.
    expect(service.selects).toEqual([{ table: "templates", limit: 5 }]);
    expect(result.serviceRole.rowCount).toBe(2);

    // Audit insert AFTER execution, via the service client.
    expect(service.inserts).toHaveLength(1);
    expect(service.inserts[0].table).toBe("console_impersonation_audit");
    expect(service.inserts[0].row).toMatchObject({
      actor_email: "amy@nsight.example",
      target_schema: "marketinghub",
      target_table: "templates",
      row_count: 1,
      success: true,
      error: null,
      claims: expect.objectContaining({ role: "authenticated" }),
    });
  });

  test("role clamp: hostile input can never mint anything but authenticated", async () => {
    const user = installUserClient(ok([]));
    h.serviceClient = buildServiceClient(ok([])).client;

    // A smuggled `role` property and service_role-flavoured groups/email.
    const hostile = {
      ...BASE_OPTS,
      email: "service_role",
      groups: ["service_role"],
      role: "service_role",
    } as unknown as ImpersonationQueryOptions;

    const result = await runImpersonatedQuery("amy@nsight.example", hostile);

    expect(result.claims.role).toBe("authenticated");
    const token = user.captured.authorization.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"] });
    expect(payload.role).toBe("authenticated");
  });

  test("the raw JWT never appears in the result — returnToken yields a fingerprint", async () => {
    const user = installUserClient(ok([]));
    h.serviceClient = buildServiceClient(ok([])).client;

    const withToken = await runImpersonatedQuery("amy@nsight.example", {
      ...BASE_OPTS,
      returnToken: true,
    });
    const minted = user.captured.authorization.replace(/^Bearer /, "");
    expect(minted).toMatch(/^eyJ/); // a real JWT was minted…
    expect(withToken.token).toMatch(/^sha256:[0-9a-f]{64}$/); // …but only its hash returns
    expect(withToken.token).not.toBe(minted);
    expect(JSON.stringify(withToken)).not.toContain(minted);

    const withoutToken = await runImpersonatedQuery(
      "amy@nsight.example",
      BASE_OPTS,
    );
    expect("token" in withoutToken).toBe(false);
    expect(JSON.stringify(withoutToken)).not.toMatch(
      /eyJ[\w-]+\.[\w-]+\.[\w-]+/,
    );
  });

  test("a PostgREST error on the user query is returned AND audited as failure", async () => {
    installUserClient({
      data: null,
      error: { message: "permission denied for table templates" },
    });
    const service = buildServiceClient(ok([{ id: "r1" }]));
    h.serviceClient = service.client;

    const result = await runImpersonatedQuery("amy@nsight.example", BASE_OPTS);

    expect(result.error).toContain("permission denied");
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBeNull();
    // service_role comparison still ran
    expect(result.serviceRole.rowCount).toBe(1);
    expect(service.inserts[0].row).toMatchObject({
      success: false,
      row_count: null,
      error: "permission denied for table templates",
    });
  });

  test("a failed audit insert is fatal (ImpersonationAuditError) and loud", async () => {
    installUserClient(ok([]));
    h.serviceClient = buildServiceClient(ok([]), {
      error: { message: "relation does not exist" },
    }).client;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runImpersonatedQuery("amy@nsight.example", BASE_OPTS),
    ).rejects.toBeInstanceOf(ImpersonationAuditError);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("audit insert failed"),
    );
  });

  test("SUPABASE_JWT_SECRET unset: fail-loud before anything is minted or run", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const service = buildServiceClient(ok([]));
    h.serviceClient = service.client;

    await expect(
      runImpersonatedQuery("amy@nsight.example", BASE_OPTS),
    ).rejects.toThrow(/SUPABASE_JWT_SECRET/);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(service.inserts).toHaveLength(0);
  });
});
