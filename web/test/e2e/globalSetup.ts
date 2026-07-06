import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

/**
 * Playwright global setup: mint a real ES256-signed `x-amzn-oidc-data` token
 * (marketing group) and publish the matching public key, exactly mirroring the
 * ALB / AWS-public-key contract that `src/lib/auth.ts` verifies. We write both
 * to a shared file:
 *
 *   - the server-side fetch shim (`preload.cjs`) serves `pem` when the app
 *     queries the ALB public-key endpoint;
 *   - the spec sets `token` as the `x-amzn-oidc-data` header on every request.
 *
 * `signer` matches the ALB_ARN the app is started with, so verification (which
 * asserts `signer === ALB_ARN`) passes for real — no auth bypass.
 */

export const E2E_ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:439024109088:loadbalancer/app/mh-e2e/e2e0000000000";
export const E2E_KID = "mh-e2e-kid";

const here = dirname(fileURLToPath(import.meta.url));
export const AUTH_FILE = join(here, ".mh-auth.json");

export default async function globalSetup(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const pem = await exportSPKI(publicKey);

  const token = await new SignJWT({
    email: "marketer@nsight.example",
    name: "E2E Marketer",
    "cognito:groups": ["marketing"],
  })
    .setProtectedHeader({ alg: "ES256", kid: E2E_KID, signer: E2E_ALB_ARN })
    .sign(privateKey);

  writeFileSync(
    AUTH_FILE,
    JSON.stringify({ token, pem, albArn: E2E_ALB_ARN }),
    "utf8",
  );
}
