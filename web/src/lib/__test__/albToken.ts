import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { vi } from "vitest";

/**
 * Test helper: mint real, ES256-signed `x-amzn-oidc-data` tokens and serve the
 * matching public key, mirroring the ALB / AWS public-key-endpoint contract that
 * `getUser` now verifies. Import from any test that exercises the auth path.
 *
 * This is NOT a test suite (no `.test.` suffix) so vitest never collects it.
 */

/** The `kid` carried in the protected header of tokens we mint by default. */
export const TEST_KID = "test-kid";

/** The ALB ARN we sign as `signer` and expect back in `ALB_ARN`. */
export const TEST_ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/marketinghub/0123456789abcdef";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: SigningKey | undefined;
let publicPem: string | undefined;

/** Generate (once per test file) the ES256 keypair used to sign test tokens. */
export async function initAlbKeys(): Promise<void> {
  if (privateKey && publicPem) return;
  const { privateKey: pk, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  privateKey = pk;
  publicPem = await exportSPKI(publicKey);
}

/** The SPKI PEM of the current test keypair (what the AWS endpoint would serve). */
export function albPublicPem(): string {
  if (!publicPem) throw new Error("initAlbKeys() must be awaited first");
  return publicPem;
}

export interface SignOptions {
  /** Protected-header `kid`; defaults to {@link TEST_KID}. */
  kid?: string;
  /** Protected-header `signer` (the ALB ARN); defaults to {@link TEST_ALB_ARN}. */
  signer?: string;
  /** Absolute `exp` in epoch-seconds; omit for a token with no expiry. */
  exp?: number;
  /** Sign with an alternate key to forge an invalid signature. */
  key?: SigningKey;
}

/** Mint an ES256-signed compact JWS shaped like ALB `x-amzn-oidc-data`. */
export async function signAlbToken(
  claims: Record<string, unknown>,
  opts: SignOptions = {},
): Promise<string> {
  if (!privateKey) throw new Error("initAlbKeys() must be awaited first");
  const jwt = new SignJWT(claims).setProtectedHeader({
    alg: "ES256",
    kid: opts.kid ?? TEST_KID,
    signer: opts.signer ?? TEST_ALB_ARN,
  });
  if (opts.exp !== undefined) jwt.setExpirationTime(opts.exp);
  return jwt.sign(opts.key ?? privateKey);
}

/**
 * Stub global `fetch` so the AWS public-key endpoint returns the test PEM for any
 * `kid`. Returns the mock so tests can assert call counts (cache behaviour).
 */
export function installAlbKeyFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(albPublicPem(), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Set the `ALB_ARN` env expected by `getUser` to the test signer. */
export function setAlbEnv(): void {
  process.env.ALB_ARN = TEST_ALB_ARN;
}

/** Clear the `ALB_ARN` env (to exercise the fail-loud misconfiguration path). */
export function clearAlbEnv(): void {
  delete process.env.ALB_ARN;
}

// ---------------------------------------------------------------------------
// Cognito ACCESS-token scaffolding (`x-amzn-oidc-accesstoken`): in production
// `cognito:groups` arrives ONLY in the access token (userinfo omits it), so
// tests mint real RS256 tokens and serve the matching JWKS from the pool URL.
// ---------------------------------------------------------------------------

export const TEST_POOL_ID = "us-east-1_TESTPOOL";
export const TEST_CLIENT_ID = "testclientid1234567890";
export const TEST_ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${TEST_POOL_ID}`;
const TEST_JWKS_KID = "cognito-test-kid";

let rsPrivateKey: SigningKey | undefined;
let jwksJson: string | undefined;

/** Generate (once per test file) the RS256 keypair + JWKS for access tokens. */
export async function initCognitoKeys(): Promise<void> {
  if (rsPrivateKey && jwksJson) return;
  const { generateKeyPair, exportJWK } = await import("jose");
  const { privateKey: pk, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  rsPrivateKey = pk;
  const jwk = await exportJWK(publicKey);
  jwksJson = JSON.stringify({
    keys: [{ ...jwk, kid: TEST_JWKS_KID, alg: "RS256", use: "sig" }],
  });
}

export interface AccessTokenOptions {
  issuer?: string;
  tokenUse?: string;
  clientId?: string;
  /** Absolute `exp` in epoch-seconds; defaults to one hour ahead. */
  exp?: number;
}

/** Mint an RS256 access token shaped like ALB `x-amzn-oidc-accesstoken`. */
export async function signAccessToken(
  claims: Record<string, unknown>,
  opts: AccessTokenOptions = {},
): Promise<string> {
  if (!rsPrivateKey) throw new Error("initCognitoKeys() must be awaited first");
  const { SignJWT: Sign } = await import("jose");
  return new Sign({
    token_use: opts.tokenUse ?? "access",
    client_id: opts.clientId ?? TEST_CLIENT_ID,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: TEST_JWKS_KID })
    .setIssuer(opts.issuer ?? TEST_ISSUER)
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(rsPrivateKey);
}

/**
 * Stub global `fetch` to serve BOTH auth endpoints: the pool JWKS for
 * `.well-known/jwks.json` URLs, the ALB public-key PEM for everything else.
 */
export function installAuthFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: unknown) => {
    if (String(url).includes("/.well-known/jwks.json")) {
      if (!jwksJson) throw new Error("initCognitoKeys() must be awaited first");
      return new Response(jwksJson, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(albPublicPem(), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Set the Cognito pool/client env consumed by the access-token group path. */
export function setCognitoEnv(): void {
  process.env.COGNITO_USER_POOL_ID = TEST_POOL_ID;
  process.env.COGNITO_CLIENT_ID = TEST_CLIENT_ID;
}

/** Clear the Cognito env (the preview/e2e profile — access token ignored). */
export function clearCognitoEnv(): void {
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
}
