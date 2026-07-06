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
} from "vitest";
import { getUser, requireUser, AuthError, type AppUser } from "./auth";
import {
  albPublicPem,
  clearAlbEnv,
  initAlbKeys,
  installAlbKeyFetch,
  setAlbEnv,
  signAlbToken,
  TEST_ALB_ARN,
} from "./__test__/albToken";

function headersWith(token?: string): Headers {
  const h = new Headers();
  if (token) h.set("x-amzn-oidc-data", token);
  return h;
}

let fetchMock: ReturnType<typeof installAlbKeyFetch>;

beforeAll(async () => {
  await initAlbKeys();
});

beforeEach(() => {
  setAlbEnv();
  fetchMock = installAlbKeyFetch();
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
});
