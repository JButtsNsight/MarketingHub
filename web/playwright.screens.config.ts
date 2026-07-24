import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { E2E_ALB_ARN } from "./test/e2e/globalSetup";

/**
 * Screenshot harness (dev/demo only — NOT `npm test`). Same real standalone
 * server + token contract as playwright.config.ts, plus a second preload that
 * shims Supabase Storage listing. Run:
 *   npx playwright test --config=playwright.screens.config.ts
 */
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 3124;

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "**/screens.spec.ts",
  globalSetup: "./test/e2e/globalSetup.ts",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `sh -c 'npm run build; rm -rf .next/standalone/.next/static .next/standalone/public; mkdir -p .next/standalone/.next; cp -R .next/static .next/standalone/.next/static; cp -R public .next/standalone/public; exec node .next/standalone/server.js'`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_OPTIONS: `--require ${join(here, "test/e2e/preload.cjs")} --require ${join(here, "test/e2e/preload.screens.cjs")}`,
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      SUPABASE_URL: "http://mh-supabase.local",
      SUPABASE_SERVICE_ROLE_KEY: "e2e-service-role-key",
      ALB_ARN: E2E_ALB_ARN,
      ALB_REGION: "us-east-1",
      AWS_REGION: "us-east-1",
      COGNITO_LOGOUT_URL: "https://example.auth.us-east-1.amazoncognito.com/logout",
    },
  },
});
