import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { AUTH_TABS, DB_TABS, LOGS_TABS } from "./tabs";

/**
 * The tab strips are plain data, but they are LOAD-BEARING navigation: every
 * console page renders its section's strip verbatim, so a wrong href here is
 * a 404 on every page of the section at once. These tests pin the shipped
 * orders and structurally guarantee each href resolves to a real page under
 * the (app) route group.
 */

// Vitest runs with cwd = web/ (import.meta.url is not file-scheme in jsdom).
const APP_DIR = join(process.cwd(), "src/app/(app)");

describe("AUTH_TABS (Wave 3-partial wiring)", () => {
  test("exact order: Overview, Users, Providers, Impersonation", () => {
    expect(AUTH_TABS).toEqual([
      { href: "/admin/auth", label: "Overview" },
      { href: "/admin/auth/users", label: "Users" },
      { href: "/admin/auth/providers", label: "Providers" },
      { href: "/admin/auth/impersonate", label: "Impersonation" },
    ]);
  });
});

describe.each([
  ["AUTH_TABS", AUTH_TABS],
  ["DB_TABS", DB_TABS],
  ["LOGS_TABS", LOGS_TABS],
])("%s consistency", (_name, tabs) => {
  test("hrefs are unique, absolute, and trailing-slash-free", () => {
    const hrefs = tabs.map((t) => t.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/[a-z0-9/-]+$/);
      expect(href.endsWith("/")).toBe(false);
    }
  });

  test("labels are unique and non-empty", () => {
    const labels = tabs.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim()).not.toBe("");
  });

  test("every href resolves to a page.tsx under the (app) route group", () => {
    for (const tab of tabs) {
      const pagePath = `${APP_DIR}${tab.href}/page.tsx`;
      expect(existsSync(pagePath), `${tab.href} → ${pagePath}`).toBe(true);
    }
  });
});
