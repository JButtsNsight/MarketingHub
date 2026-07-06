import { test, expect, type BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AUTH_FILE } from "./globalSetup";

/**
 * End-to-end happy path against the REAL app (Next server + route handlers +
 * server components), with:
 *   - a genuine ES256 `x-amzn-oidc-data` marketing-group token verified by the
 *     app's auth layer (public key served by the preload shim), and
 *   - Supabase stubbed in-process by the preload shim.
 *
 * Flow: empty grid -> upload a template -> it appears in the grid -> search
 * finds it -> open its preview.
 */

/** The marketing-group token minted by globalSetup. */
function albToken(): string {
  return JSON.parse(readFileSync(AUTH_FILE, "utf8")).token as string;
}

/** A context whose every request carries the ALB OIDC identity header. */
async function marketingContext(browser: {
  newContext: (o: object) => Promise<BrowserContext>;
}): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: { "x-amzn-oidc-data": albToken() },
  });
}

test("upload → appears in grid → search finds it → open preview", async ({
  browser,
}) => {
  const context = await marketingContext(browser);
  const page = await context.newPage();

  const unique = `Spring Promo E2E ${Date.now()}`;
  const bodyText = "Hello marketer, enjoy 20% off this spring.";

  // 1. Templates page starts empty (in-memory store is fresh).
  await page.goto("/templates");
  await expect(
    page.getByRole("heading", { name: "Templates", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No templates found")).toBeVisible();

  // 2. Upload a new text template.
  await page.goto("/templates/new");
  await expect(
    page.getByRole("heading", { name: "Upload a template" }),
  ).toBeVisible();
  await page.locator("#tpl-name").fill(unique);
  await page.locator("#tpl-body").fill(bodyText);
  await page.getByRole("button", { name: "Save template" }).click();

  // 3. Redirected to the new template's detail/preview page.
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: unique })).toBeVisible();
  await expect(page.getByText(bodyText)).toBeVisible();

  // 4. It appears in the browse grid.
  await page.goto("/templates");
  await expect(page.getByText(unique)).toBeVisible();

  // 5. Full-text search finds it by a word from the name.
  await page.getByRole("searchbox", { name: "Search templates" }).fill("spring");
  await page.waitForURL(/\/templates\?.*q=spring/);
  await expect(page.getByText(unique)).toBeVisible();

  // A search that cannot match hides it (empty state).
  await page
    .getByRole("searchbox", { name: "Search templates" })
    .fill("zzznomatchzzz");
  await expect(page.getByText("No templates found")).toBeVisible();

  // 6. Open the preview from the grid once more.
  await page.getByRole("searchbox", { name: "Search templates" }).fill("spring");
  await expect(page.getByText(unique)).toBeVisible();
  await page.getByRole("link", { name: unique }).click();
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: unique })).toBeVisible();
  await expect(page.getByText(bodyText)).toBeVisible();

  await context.close();
});

test("without the marketing OIDC header the app does not expose templates", async ({
  browser,
}) => {
  // No x-amzn-oidc-data header → requireMarketingUser redirects to /login.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/templates");
  await page.waitForURL(/\/login/);
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});
