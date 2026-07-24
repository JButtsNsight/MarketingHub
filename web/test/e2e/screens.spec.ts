import { test, type BrowserContext } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTH_FILE } from "./globalSetup";

/**
 * Screenshot harness (dev/demo only). Seeds a few templates through the REAL
 * API (verified marketing token + in-memory Supabase shim), then captures each
 * console page in light and dark. Output → ~/Documents/MarketingHub-Console-Screens.
 * Run: npx playwright test --config=playwright.screens.config.ts
 */
function albToken(): string {
  return JSON.parse(readFileSync(AUTH_FILE, "utf8")).token as string;
}

const OUT = join(homedir(), "Documents", "MarketingHub-Console-Screens");

const SEED = [
  { name: "Spring Sale Blast", type: "email", category: "Promotion", tags: ["spring", "sale"], subject: "20% off all spring styles", body: "<h1>Spring Sale</h1><p>Enjoy 20% off everything this spring.</p>" },
  { name: "Monthly Newsletter — March", type: "email", category: "Newsletter", tags: ["monthly"], subject: "Your March update", body: "<p>Here is what is new this month at NSight.</p>" },
  { name: "Welcome Series 1", type: "email", category: "Onboarding", tags: ["welcome", "drip"], subject: "Welcome to NSight", body: "<p>Welcome aboard — let us get you started.</p>" },
  { name: "Appointment Reminder", type: "text", category: "Transactional", tags: ["sms", "reminder"], body: "Reminder: your appointment is tomorrow at 10:00am." },
  { name: "Product Launch Announcement", type: "email", category: "Announcement", tags: ["launch"], subject: "Introducing our new platform", body: "<p>Big news — our new platform is live.</p>" },
  { name: "Re-engagement Nudge", type: "text", category: "Promotion", tags: ["winback"], body: "We miss you — here is 10% off your next order." },
];

const ROUTES: [string, string][] = [
  ["overview", "/overview"],
  ["database-rows", "/database"],
  ["database-schema", "/database/schema"],
  ["database-rls", "/database/rls"],
  ["storage", "/storage"],
  ["auth", "/auth"],
  ["api-reference", "/api-reference"],
  ["infrastructure", "/infrastructure"],
  ["settings", "/settings"],
  ["templates", "/templates"],
];

async function marketingContext(browser: {
  newContext: (o: object) => Promise<BrowserContext>;
}): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: { "x-amzn-oidc-data": albToken() },
  });
}

test("capture console screenshots (light + dark)", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const context = await marketingContext(browser);

  // Seed templates through the real POST /api/templates path.
  for (const t of SEED) {
    const res = await context.request.post("/api/templates", { data: t });
    // eslint-disable-next-line no-console
    console.log(`seed ${t.name}: ${res.status()}`);
  }

  for (const theme of ["light", "dark"] as const) {
    const page = await context.newPage();
    await page.addInitScript(
      ([t, s]) => {
        try {
          localStorage.setItem("mh-theme", t);
          localStorage.setItem("mh-skin", s);
        } catch {
          /* ignore */
        }
      },
      [theme, "glass"],
    );
    for (const [name, route] of ROUTES) {
      await page.goto(route, { waitUntil: "load" });
      await page.waitForTimeout(250);
      await page.screenshot({
        path: join(OUT, `${name}-${theme}.png`),
        fullPage: true,
      });
    }
    await page.close();
  }

  // Login (bare, self-contained dark screen).
  const loginPage = await context.newPage();
  await loginPage.goto("/login", { waitUntil: "load" });
  await loginPage.waitForTimeout(250);
  await loginPage.screenshot({ path: join(OUT, "login.png"), fullPage: true });
  await loginPage.close();

  await context.close();
});
