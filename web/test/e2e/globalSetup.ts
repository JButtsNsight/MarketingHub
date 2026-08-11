import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";

/**
 * Playwright global setup: mint real ES256-signed `x-amzn-oidc-data` tokens
 * (a marketing-group persona and an admin persona) and publish the matching
 * public key, exactly mirroring the ALB / AWS-public-key contract that
 * `src/lib/auth.ts` verifies. We write all of it to a shared file:
 *
 *   - the server-side fetch shim (`preload.cjs`) serves `pem` when the app
 *     queries the ALB public-key endpoint;
 *   - specs set `token` (marketing) or `adminToken` (marketing +
 *     marketinghub-admins) as the `x-amzn-oidc-data` header per context.
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

  /** Sign an `x-amzn-oidc-data` token for one persona (same key + signer). */
  const mint = (email: string, name: string, groups: string[]) =>
    new SignJWT({ email, name, "cognito:groups": groups })
      .setProtectedHeader({ alg: "ES256", kid: E2E_KID, signer: E2E_ALB_ARN })
      .sign(privateKey);

  const token = await mint("marketer@nsight.example", "E2E Marketer", [
    "marketing",
  ]);
  const adminToken = await mint("admin@nsight.example", "E2E Admin", [
    "marketing",
    "marketinghub-admins",
  ]);

  writeFileSync(
    AUTH_FILE,
    JSON.stringify({ token, adminToken, pem, albArn: E2E_ALB_ARN }),
    "utf8",
  );
}
