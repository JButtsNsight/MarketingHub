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
