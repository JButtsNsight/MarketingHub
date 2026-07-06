import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { E2E_ALB_ARN } from "./test/e2e/globalSetup";

/**
 * e2e config. The app is run for real (`next start`) in a single Node process
 * with a `--require` preload that (a) serves the test ALB public key so the
 * OIDC signature verifies and (b) backs Supabase with an in-memory store. The
 * spec injects the marketing-group `x-amzn-oidc-data` header per context.
 *
 * Not part of `npm test` (vitest) — run with `npx playwright test`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3123;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./test/e2e/globalSetup.ts",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Build once if needed, stage the standalone server's static/public assets
    // (as the Dockerfile does), then run it. `next start` is incompatible with
    // `output: standalone`, so we launch the standalone server directly — a
    // single process, so the preload's global.fetch + in-memory store are shared.
    command: `sh -c 'npm run build; rm -rf .next/standalone/.next/static .next/standalone/public; mkdir -p .next/standalone/.next; cp -R .next/static .next/standalone/.next/static; cp -R public .next/standalone/public; exec node .next/standalone/server.js'`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_OPTIONS: `--require ${join(here, "test/e2e/preload.cjs")}`,
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      // Intercepted by the preload; the values only need to be present.
      SUPABASE_URL: "http://mh-supabase.local",
      SUPABASE_SERVICE_ROLE_KEY: "e2e-service-role-key",
      // The app asserts the OIDC token `signer` equals this ARN (see auth.ts).
      ALB_ARN: E2E_ALB_ARN,
      ALB_REGION: "us-east-1",
      AWS_REGION: "us-east-1",
    },
  },
});
