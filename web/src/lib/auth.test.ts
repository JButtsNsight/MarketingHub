// @vitest-environment node
// auth is server-only (jose ES256 verification); node env avoids the jsdom
// cross-realm Uint8Array mismatch that breaks WebCrypto sign/verify.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getUser, requireUser, AuthError, type AppUser } from "./auth";
import { ADMIN_GROUP, isAdmin, MARKETING_GROUP } from "./authGroups";
import {
  albPublicPem,
  clearAlbEnv,
  clearCognitoEnv,
  initAlbKeys,
  initCognitoKeys,
  installAlbKeyFetch,
  installAuthFetch,
  setAlbEnv,
  setCognitoEnv,
  signAccessToken,
  signAlbToken,
  TEST_ALB_ARN,
} from "./__test__/albToken";

// next/headers + next/navigation exist only inside a Next request scope; mock
// them (requireMarketingUser.test.ts pattern) so requireAdminUser is testable.
// auth.ts itself imports neither, so the other suites are unaffected.
const nextMocks = vi.hoisted(() => ({
  headerValue: null as string | null,
  cookieValue: null as string | null,
  redirect: vi.fn((_url: string) => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "x-amzn-oidc-data"
          ? nextMocks.headerValue
          : name === "cookie"
            ? nextMocks.cookieValue
            : null,
    }),
}));
vi.mock("next/navigation", () => ({ redirect: nextMocks.redirect }));

// requireAdminUser consults the live pool through cognitoAdmin; mock the module
// so the block stays a unit test (no AWS SDK). Default null = live check
// unavailable (the preview/e2e reality), i.e. the token verdict stands.
const cognitoMocks = vi.hoisted(() => ({
  liveGroupsFor: vi.fn(async (_email: string): Promise<string[] | null> => null),
}));
vi.mock("./cognitoAdmin", () => ({ liveGroupsFor: cognitoMocks.liveGroupsFor }));

import { requireAdminUser } from "./requireAdminUser";

function headersWith(token?: string): Headers {
  const h = new Headers();
  if (token) h.set("x-amzn-oidc-data", token);
  return h;
}

function withCookie(h: Headers, cookie: string): Headers {
  h.set("cookie", cookie);
  return h;
}

let fetchMock: ReturnType<typeof installAlbKeyFetch>;

beforeAll(async () => {
  await initAlbKeys();
});

beforeEach(() => {
  setAlbEnv();
  fetchMock = installAlbKeyFetch();
  nextMocks.headerValue = null;
  nextMocks.cookieValue = null;
  nextMocks.redirect.mockClear();
});

afterEach(() => {
  clearAlbEnv();
  delete process.env.ALB_REGION;
  delete process.env.AWS_REGION;
  delete process.env.PREVIEW_AUTH;
});

describe("getUser (verified)", () => {
  it("returns email, name, and groups from a validly SIGNED ALB token", async () => {
    const token = await signAlbToken({
      email: "casey@nsightcare.com",
      name: "Casey Marketer",
      "cognito:groups": ["marketing", "marketinghub-admins"],
    });
    const user = await getUser(headersWith(token));
    expect(user).toEqual<AppUser>({
      email: "casey@nsightcare.com",
      name: "Casey Marketer",
      groups: ["marketing", "marketinghub-admins"],
    });
  });

  it("IGNORES the persona cookie on the verified path (PREVIEW_AUTH unset)", async () => {
    // Real ALB tokens carry the groups; a cookie must never demote (or shape)
    // them outside the preview shim.
    const token = await signAlbToken({
      email: "casey@nsightcare.com",
      "cognito:groups": ["marketing", "marketinghub-admins"],
    });
    const user = await getUser(
      withCookie(headersWith(token), "mh-preview-persona=member"),
    );
    expect(user?.groups).toEqual(["marketing", "marketinghub-admins"]);
  });

  it("accepts cognito:groups rendered as a bracketed/space string", async () => {
    const token = await signAlbToken({
      email: "dana@nsightcare.com",
      "cognito:groups": "[marketing admins]",
    });
    const user = await getUser(headersWith(token));
    expect(user?.groups).toEqual(["marketing", "admins"]);
  });

  it("falls back to email for the display name when no name claim is present", async () => {
    const token = await signAlbToken({
      email: "noname@nsightcare.com",
      "cognito:groups": [],
    });
    expect((await getUser(headersWith(token)))?.name).toBe(
      "noname@nsightcare.com",
    );
  });

  it("uses given_name when name is absent", async () => {
    const token = await signAlbToken({
      email: "gn@nsightcare.com",
      given_name: "Gina",
      "cognito:groups": [],
    });
    expect((await getUser(headersWith(token)))?.name).toBe("Gina");
  });

  it("returns null for a TAMPERED payload (privilege escalation is rejected)", async () => {
    // A real signed token for a low-privilege user...
    const valid = await signAlbToken({
      email: "bob@nsightcare.com",
      "cognito:groups": ["viewers"],
    });
    // ...whose payload an attacker swaps to grant themselves admin, keeping the
    // original signature. Verification must fail (the sig no longer matches).
    const [header, , sig] = valid.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        email: "bob@nsightcare.com",
        "cognito:groups": ["marketinghub-admins"],
      }),
    ).toString("base64url");
    const tampered = `${header}.${forgedPayload}.${sig}`;
    expect(await getUser(headersWith(tampered))).toBeNull();
  });

  it("returns null when signed by the WRONG (attacker) key", async () => {
    const { generateKeyPair } = await import("jose");
    const attacker = await generateKeyPair("ES256", { extractable: true });
    const token = await signAlbToken(
      { email: "mallory@nsightcare.com", "cognito:groups": ["marketing"] },
      { key: attacker.privateKey },
    );
    expect(await getUser(headersWith(token))).toBeNull();
  });

  it("returns null when the token's signer is NOT the expected ALB_ARN", async () => {
    const token = await signAlbToken(
      { email: "eve@nsightcare.com", "cognito:groups": ["marketing"] },
      {
        signer:
          "arn:aws:elasticloadbalancing:us-east-1:999999999999:loadbalancer/app/evil/deadbeef",
      },
    );
    expect(await getUser(headersWith(token))).toBeNull();
  });

  it("returns null for an EXPIRED token", async () => {
    const token = await signAlbToken(
      { email: "old@nsightcare.com", "cognito:groups": ["marketing"] },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    );
    expect(await getUser(headersWith(token))).toBeNull();
  });

  it("returns null when the header is absent", async () => {
    expect(await getUser(headersWith())).toBeNull();
  });

  it("returns null on a malformed token", async () => {
    expect(await getUser(headersWith("garbage"))).toBeNull();
  });

  it("returns null when the (verified) payload carries no email", async () => {
    const token = await signAlbToken({ "cognito:groups": ["marketing"] });
    expect(await getUser(headersWith(token))).toBeNull();
  });

  it("reads from a plain header record as well as a Headers instance", async () => {
    const token = await signAlbToken({
      email: "rec@nsightcare.com",
      "cognito:groups": ["marketing"],
    });
    const user = await getUser({ "x-amzn-oidc-data": token });
    expect(user?.email).toBe("rec@nsightcare.com");
  });

  it("THROWS a config error when a token is present but ALB_ARN is unset", async () => {
    clearAlbEnv();
    const token = await signAlbToken({
      email: "casey@nsightcare.com",
      "cognito:groups": ["marketing"],
    });
    await expect(getUser(headersWith(token))).rejects.toThrow(/ALB_ARN/);
  });

  it("does NOT throw (returns null) when there is no token and ALB_ARN is unset", async () => {
    clearAlbEnv();
    expect(await getUser(headersWith())).toBeNull();
  });

  it("fetches the public key once, then serves it from cache", async () => {
    // A kid used by no other test so the module cache starts empty for it.
    const kid = "cache-only-kid";
    const mkToken = () =>
      signAlbToken(
        { email: "cache@nsightcare.com", "cognito:groups": ["marketing"] },
        { kid },
      );
    expect((await getUser(headersWith(await mkToken())))?.email).toBe(
      "cache@nsightcare.com",
    );
    expect((await getUser(headersWith(await mkToken())))?.email).toBe(
      "cache@nsightcare.com",
    );
    // Two verifications, same kid → the AWS key endpoint is hit exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hits the AWS key endpoint for the token's region + kid", async () => {
    const token = await signAlbToken(
      { email: "url@nsightcare.com", "cognito:groups": ["marketing"] },
      { kid: "url-kid" },
    );
    await getUser(headersWith(token));
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      "https://public-keys.auth.elb.us-east-1.amazonaws.com/url-kid",
    );
    // sanity: the served PEM is what importSPKI consumes
    expect(albPublicPem()).toContain("BEGIN PUBLIC KEY");
    expect(TEST_ALB_ARN).toContain("loadbalancer");
  });
});

describe("getUser (internal-preview shim, default OFF)", () => {
  // The no-SAML private deployment fronts the app with an INTERNAL HTTP:80 ALB
  // that carries no `x-amzn-oidc-data` token. When PREVIEW_AUTH is a non-empty
  // string, getUser returns a stub user in that group WITHOUT reading/verifying
  // any token and WITHOUT needing ALB_ARN. When unset/empty, behaviour above is
  // unchanged.
  it("returns a stub marketing user with NO token and NO ALB_ARN when PREVIEW_AUTH is set", async () => {
    clearAlbEnv(); // preview needs no expected-signer config
    process.env.PREVIEW_AUTH = "marketing";
    const user = await getUser(headersWith()); // no x-amzn-oidc-data header
    expect(user).toEqual<AppUser>({
      email: "preview@nsightcare.com",
      name: "Preview User",
      groups: ["marketing"],
    });
  });

  it("puts the PREVIEW_AUTH value into the stub user's groups", async () => {
    process.env.PREVIEW_AUTH = "custom-group";
    expect((await getUser(headersWith()))?.groups).toEqual(["custom-group"]);
  });

  it("parses a comma-separated PREVIEW_AUTH into MULTIPLE groups", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    expect((await getUser(headersWith()))?.groups).toEqual([
      "marketing",
      "marketinghub-admins",
    ]);
  });

  it("drops the admin group when the mh-preview-persona=member cookie is set", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    const user = await getUser(
      withCookie(headersWith(), "theme=dark; mh-preview-persona=member"),
    );
    expect(user?.groups).toEqual(["marketing"]);
  });

  it("keeps every group for any OTHER persona cookie value", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    const user = await getUser(
      withCookie(headersWith(), "mh-preview-persona=admin"),
    );
    expect(user?.groups).toEqual(["marketing", "marketinghub-admins"]);
  });

  it("requireUser 403s an ADMIN_GROUP check after the member persona drops it", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    await expect(
      requireUser(
        withCookie(headersWith(), "mh-preview-persona=member"),
        ADMIN_GROUP,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requireUser passes an ADMIN_GROUP check when the shim lists it (no cookie)", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    const user = await requireUser(headersWith(), ADMIN_GROUP);
    expect(user.groups).toContain(ADMIN_GROUP);
  });

  it("ignores any incoming token entirely (no verification) when PREVIEW_AUTH is set", async () => {
    clearAlbEnv();
    process.env.PREVIEW_AUTH = "marketing";
    // A garbage token neither throws nor nulls — the shim short-circuits first.
    expect((await getUser(headersWith("garbage")))?.email).toBe(
      "preview@nsightcare.com",
    );
  });

  it("treats an EMPTY PREVIEW_AUTH as OFF (verification path unchanged)", async () => {
    process.env.PREVIEW_AUTH = ""; // empty string is not "set"
    expect(await getUser(headersWith())).toBeNull();
  });

  it("requireUser works on top of the stub (marketing group present)", async () => {
    clearAlbEnv();
    process.env.PREVIEW_AUTH = "marketing";
    const user = await requireUser(headersWith(), "marketing");
    expect(user.email).toBe("preview@nsightcare.com");
  });

  it("requireUser 403s on the stub when a different group is required", async () => {
    process.env.PREVIEW_AUTH = "marketing";
    await expect(
      requireUser(headersWith(), "marketinghub-admins"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("requireUser (verified)", () => {
  async function marketingToken(): Promise<string> {
    return signAlbToken({
      email: "casey@nsightcare.com",
      name: "Casey",
      "cognito:groups": ["marketing"],
    });
  }

  it("returns the user when the required group is present", async () => {
    const user = await requireUser(headersWith(await marketingToken()), "marketing");
    expect(user.email).toBe("casey@nsightcare.com");
  });

  it("returns the user when no specific group is required", async () => {
    const user = await requireUser(headersWith(await marketingToken()));
    expect(user.email).toBe("casey@nsightcare.com");
  });

  it("throws a 401 AuthError when there is no authenticated user", async () => {
    await expect(requireUser(headersWith(), "marketing")).rejects.toMatchObject({
      status: 401,
    });
    await expect(requireUser(headersWith())).rejects.toBeInstanceOf(AuthError);
  });

  it("throws a 403 AuthError when the user lacks the required group", async () => {
    await expect(
      requireUser(headersWith(await marketingToken()), "marketinghub-admins"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws a 403 AuthError for a marketing user missing ADMIN_GROUP", async () => {
    await expect(
      requireUser(headersWith(await marketingToken()), ADMIN_GROUP),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("authGroups", () => {
  it("isAdmin is true only when ADMIN_GROUP is present", () => {
    expect(isAdmin({ groups: [MARKETING_GROUP, ADMIN_GROUP] })).toBe(true);
    expect(isAdmin({ groups: [MARKETING_GROUP] })).toBe(false);
    expect(isAdmin({ groups: [] })).toBe(false);
  });
});

describe("requireAdminUser (admin page gate)", () => {
  beforeEach(() => {
    cognitoMocks.liveGroupsFor.mockClear();
    cognitoMocks.liveGroupsFor.mockResolvedValue(null); // live check unavailable
  });

  it("returns ok + the user for a signed-in admin", async () => {
    nextMocks.headerValue = await signAlbToken({
      email: "admin@nsightcare.com",
      "cognito:groups": ["marketing", "marketinghub-admins"],
    });
    const gate = await requireAdminUser();
    expect(gate).toMatchObject({
      ok: true,
      user: { email: "admin@nsightcare.com" },
    });
    expect(nextMocks.redirect).not.toHaveBeenCalled();
  });

  it("returns ok:false (NOT a /login redirect) for a signed-in non-admin", async () => {
    nextMocks.headerValue = await signAlbToken({
      email: "casey@nsightcare.com",
      "cognito:groups": ["marketing"],
    });
    expect(await requireAdminUser()).toEqual({ ok: false });
    expect(nextMocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects a signed-OUT user to /login", async () => {
    nextMocks.headerValue = null;
    await expect(requireAdminUser()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(nextMocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("honors the member persona under PREVIEW_AUTH (ok:false)", async () => {
    clearAlbEnv();
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    nextMocks.cookieValue = "mh-preview-persona=member";
    expect(await requireAdminUser()).toEqual({ ok: false });
    expect(nextMocks.redirect).not.toHaveBeenCalled();
  });

  // Live pool check (near-instant revocation) — REVOCATION-ONLY semantics.
  it("consults live groups for the token's email and stays ok when admin persists", async () => {
    cognitoMocks.liveGroupsFor.mockResolvedValue(["marketing", ADMIN_GROUP]);
    nextMocks.headerValue = await signAlbToken({
      email: "admin@nsightcare.com",
      "cognito:groups": [ADMIN_GROUP],
    });
    expect(await requireAdminUser()).toMatchObject({ ok: true });
    // Page renders ride the cached (60s) live check; only writes force fresh.
    expect(cognitoMocks.liveGroupsFor).toHaveBeenCalledWith(
      "admin@nsightcare.com",
      undefined,
      { fresh: false },
    );
  });

  it("REVOKES a valid admin token when the live pool no longer grants ADMIN_GROUP", async () => {
    cognitoMocks.liveGroupsFor.mockResolvedValue(["marketing"]); // demoted
    nextMocks.headerValue = await signAlbToken({
      email: "revoked@nsightcare.com",
      "cognito:groups": [ADMIN_GROUP],
    });
    expect(await requireAdminUser()).toEqual({ ok: false });
    expect(nextMocks.redirect).not.toHaveBeenCalled();
  });

  it("treats a deleted pool user (live []) as revoked", async () => {
    cognitoMocks.liveGroupsFor.mockResolvedValue([]);
    nextMocks.headerValue = await signAlbToken({
      email: "gone@nsightcare.com",
      "cognito:groups": [ADMIN_GROUP],
    });
    expect(await requireAdminUser()).toEqual({ ok: false });
  });

  it("fails OPEN: a live-check failure (null) leaves the token verdict standing", async () => {
    cognitoMocks.liveGroupsFor.mockResolvedValue(null); // Cognito blip
    nextMocks.headerValue = await signAlbToken({
      email: "admin@nsightcare.com",
      "cognito:groups": [ADMIN_GROUP],
    });
    expect(await requireAdminUser()).toMatchObject({ ok: true });
  });

  it("NEVER grants from live groups: a non-admin token stays ok:false without a pool call", async () => {
    cognitoMocks.liveGroupsFor.mockResolvedValue([ADMIN_GROUP]); // pool says admin
    nextMocks.headerValue = await signAlbToken({
      email: "casey@nsightcare.com",
      "cognito:groups": ["marketing"], // token does not
    });
    expect(await requireAdminUser()).toEqual({ ok: false });
    expect(cognitoMocks.liveGroupsFor).not.toHaveBeenCalled();
  });
});

describe("production groups via x-amzn-oidc-accesstoken", () => {
  beforeAll(async () => {
    await initAlbKeys();
    await initCognitoKeys();
  });

  beforeEach(() => {
    installAuthFetch();
    setAlbEnv();
    setCognitoEnv();
  });

  afterEach(() => {
    clearCognitoEnv();
  });

  async function prodHeaders(
    identityClaims: Record<string, unknown>,
    accessToken?: string,
  ): Promise<Headers> {
    const h = headersWith(await signAlbToken(identityClaims));
    if (accessToken) h.set("x-amzn-oidc-accesstoken", accessToken);
    return h;
  }

  it("keeps identity-header groups when present (preview/e2e path untouched)", async () => {
    const h = await prodHeaders(
      { email: "a@b.com", "cognito:groups": ["marketing"] },
      await signAccessToken({ "cognito:groups": ["other"] }),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual(["marketing"]);
  });

  it("reads groups from the verified access token when userinfo has none", async () => {
    const h = await prodHeaders(
      { email: "jbutts@nsightcare.com" }, // real front door: NO groups in userinfo
      await signAccessToken({
        "cognito:groups": [MARKETING_GROUP, ADMIN_GROUP],
      }),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([MARKETING_GROUP, ADMIN_GROUP]);
  });

  it("requireUser admits an admin whose groups arrive only via access token", async () => {
    const h = await prodHeaders(
      { email: "jbutts@nsightcare.com" },
      await signAccessToken({
        "cognito:groups": [MARKETING_GROUP, ADMIN_GROUP],
      }),
    );
    await expect(requireUser(h, ADMIN_GROUP)).resolves.toMatchObject({
      email: "jbutts@nsightcare.com",
    });
  });

  it("rejects an ID token masquerading as an access token (token_use)", async () => {
    const h = await prodHeaders(
      { email: "a@b.com" },
      await signAccessToken(
        { "cognito:groups": [ADMIN_GROUP] },
        { tokenUse: "id" },
      ),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });

  it("rejects a token for a different client id", async () => {
    const h = await prodHeaders(
      { email: "a@b.com" },
      await signAccessToken(
        { "cognito:groups": [ADMIN_GROUP] },
        { clientId: "someone-elses-client" },
      ),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });

  it("rejects a token from a different issuer", async () => {
    const h = await prodHeaders(
      { email: "a@b.com" },
      await signAccessToken(
        { "cognito:groups": [ADMIN_GROUP] },
        { issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EVIL" },
      ),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });

  it("rejects an expired access token", async () => {
    const h = await prodHeaders(
      { email: "a@b.com" },
      await signAccessToken(
        { "cognito:groups": [ADMIN_GROUP] },
        { exp: Math.floor(Date.now() / 1000) - 60 },
      ),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });

  it("stays group-less without COGNITO_USER_POOL_ID (preview/e2e profile)", async () => {
    clearCognitoEnv();
    const h = await prodHeaders(
      { email: "a@b.com" },
      await signAccessToken({ "cognito:groups": [ADMIN_GROUP] }),
    );
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });

  it("stays group-less when the access-token header is absent", async () => {
    const h = await prodHeaders({ email: "a@b.com" });
    const user = await getUser(h);
    expect(user?.groups).toEqual([]);
  });
});
