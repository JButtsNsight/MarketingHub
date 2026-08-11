import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { AUTH_FILE } from "./globalSetup";

/**
 * RBAC end-to-end: the Admin nav group and its surfaces are gated on the
 * `marketinghub-admins` Cognito group, through REAL token verification —
 * globalSetup mints both personas with the same ALB key, so the only
 * difference between them is the `cognito:groups` claim.
 *
 * Contract under test (plan Track A): non-admins never see the Admin nav
 * group; a direct admin URL renders the terse 403 panel (NOT a /login
 * redirect — they ARE signed in); admin APIs answer 403 JSON. Admins see and
 * load everything.
 */

type Persona = "marketing" | "admin";

/** The persona token minted by globalSetup. */
function albToken(persona: Persona): string {
  const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  return (persona === "admin" ? auth.adminToken : auth.token) as string;
}

/** A context whose every request carries the persona's ALB OIDC header. */
async function personaContext(
  browser: { newContext: (o: object) => Promise<BrowserContext> },
  persona: Persona,
): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: { "x-amzn-oidc-data": albToken(persona) },
  });
}

/** The left nav rail (aria-label="Primary") on any console page. */
function nav(page: Page) {
  return page.getByRole("navigation", { name: "Primary" });
}

test("admin sees the Admin nav group and loads /admin/advisors", async ({
  browser,
}) => {
  const context = await personaContext(browser, "admin");
  const page = await context.newPage();

  // The Admin group is in the nav on a regular console page.
  await page.goto("/templates");
  await expect(nav(page).getByText("Admin", { exact: true })).toBeVisible();
  await expect(nav(page).getByRole("link", { name: "Advisors" })).toBeVisible();

  // The admin surface itself renders — no 403 panel, no redirect.
  await nav(page).getByRole("link", { name: "Advisors" }).click();
  await page.waitForURL(/\/admin\/advisors$/);
  await expect(page.getByRole("heading", { name: "Advisors" })).toBeVisible();
  await expect(page.getByText(/403/)).toHaveCount(0);

  await context.close();
});

test("non-admin sees no Admin nav group and gets the terse 403, not /login", async ({
  browser,
}) => {
  const context = await personaContext(browser, "marketing");
  const page = await context.newPage();

  // Nav hides the whole Admin group (display only; the routes enforce).
  await page.goto("/templates");
  await expect(nav(page).getByRole("link", { name: "Templates" })).toBeVisible();
  await expect(nav(page).getByText("Admin", { exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole("link", { name: "Advisors" })).toHaveCount(0);

  // Direct URL: a signed-in non-admin stays on the page and gets the terse
  // 403 panel — never a bounce to /login (that reads as a redirect loop).
  await page.goto("/admin/advisors");
  await expect(page).toHaveURL(/\/admin\/advisors$/);
  await expect(page.getByText(/403/).first()).toBeVisible();

  // Admin API: 403 JSON, same body for every gated console route.
  const res = await context.request.get("/api/console/advisors");
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "admin-only" });

  await context.close();
});
