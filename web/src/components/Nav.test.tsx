import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ pathname: "/overview" }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
}));

import { NAV_GROUPS, Nav } from "./Nav";

afterEach(cleanup);

describe("NAV_GROUPS — Studio IA parity", () => {
  it("names and orders the platform group like Supabase Studio", () => {
    const platform = NAV_GROUPS.find((g) => g.label === "Platform");
    expect(platform).toBeDefined();
    expect(platform!.items.map((i) => i.label)).toEqual([
      "Table Editor",
      "SQL Editor",
      "Database",
      "Storage",
      "Edge Functions",
      "Realtime",
      "API Docs",
      "Reports",
      "Logs",
    ]);
  });

  it("exposes pg_cron / pgmq / supabase_vault under an Integrations group", () => {
    const integrations = NAV_GROUPS.find((g) => g.label === "Integrations");
    expect(integrations).toBeDefined();
    expect(integrations!.items.map((i) => [i.label, i.href])).toEqual([
      ["Cron", "/integrations/cron"],
      ["Queues", "/integrations/queues"],
      ["Vault", "/integrations/vault"],
    ]);
  });

  it("slots Competitor Intel in the Marketing group, after Suppressions", () => {
    const marketing = NAV_GROUPS.find((g) => g.label === "Marketing");
    expect(marketing).toBeDefined();
    expect(marketing!.items.map((i) => [i.label, i.href])).toEqual([
      ["Templates", "/templates"],
      ["SMS Campaigns", "/campaigns"],
      ["Inbox", "/inbox"],
      ["Review queue", "/review"],
      ["Suppressions", "/suppressions"],
      ["Competitor Intel", "/intel"],
    ]);
  });

  it("lists the admin pages in their own Admin group — no /admin landing item", () => {
    const admin = NAV_GROUPS.find((g) => g.label === "Admin");
    expect(admin).toBeDefined();
    expect(admin!.items.map((i) => [i.label, i.href])).toEqual([
      ["Authentication", "/admin/auth"],
      ["Advisors", "/admin/advisors"],
      ["Cloud", "/admin/cloud"],
    ]);
  });

  it("orders the groups Overview → Platform → Integrations → Marketing → Admin → Project", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      undefined,
      "Platform",
      "Integrations",
      "Marketing",
      "Admin",
      "Project",
    ]);
  });

  it("keeps Project down to Infrastructure and Settings", () => {
    const project = NAV_GROUPS.find((g) => g.label === "Project");
    expect(project).toBeDefined();
    expect(project!.items.map((i) => [i.label, i.href])).toEqual([
      ["Infrastructure", "/infrastructure"],
      ["Settings", "/settings"],
    ]);
  });

  it("points Table Editor at the grid and Database at the schema section", () => {
    const platform = NAV_GROUPS.find((g) => g.label === "Platform")!;
    const byLabel = Object.fromEntries(
      platform.items.map((i) => [i.label, i.href]),
    );
    expect(byLabel["Table Editor"]).toBe("/database");
    expect(byLabel["Database"]).toBe("/database/schema");
    expect(byLabel["SQL Editor"]).toBe("/sql");
  });

  it("routes the Wave-5 consoles at /functions and /realtime", () => {
    const platform = NAV_GROUPS.find((g) => g.label === "Platform")!;
    const byLabel = Object.fromEntries(
      platform.items.map((i) => [i.label, i.href]),
    );
    expect(byLabel["Edge Functions"]).toBe("/functions");
    expect(byLabel["Realtime"]).toBe("/realtime");
  });

  it("routes the Wave-6 observability surfaces at /reports and /logs", () => {
    const platform = NAV_GROUPS.find((g) => g.label === "Platform")!;
    const byLabel = Object.fromEntries(
      platform.items.map((i) => [i.label, i.href]),
    );
    expect(byLabel["Reports"]).toBe("/reports");
    expect(byLabel["Logs"]).toBe("/logs");
  });
});

describe("Nav active state — most-specific match wins", () => {
  const activeLabels = () =>
    screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page")
      .map((a) => a.textContent);

  it("lights ONLY Table Editor on /database (not the nested Database item)", () => {
    h.pathname = "/database";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Table Editor"]);
  });

  it("lights ONLY Database on /database/schema (the longer matching href)", () => {
    h.pathname = "/database/schema";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Database"]);
  });

  it("lights ONLY Database on /database/rls too", () => {
    h.pathname = "/database/rls";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Database"]);
  });

  it("lights SQL Editor on /sql", () => {
    h.pathname = "/sql";
    render(<Nav />);
    expect(activeLabels()).toEqual(["SQL Editor"]);
  });

  it("lights Reports on /reports", () => {
    h.pathname = "/reports";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Reports"]);
  });

  it("keeps Logs lit across the drains sub-route", () => {
    h.pathname = "/logs/drains";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Logs"]);
  });

  it("lights ONLY Database (not Table Editor) on /database/backups", () => {
    h.pathname = "/database/backups";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Database"]);
  });

  it("lights Vault on /integrations/vault", () => {
    h.pathname = "/integrations/vault";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Vault"]);
  });

  it("lights nothing on /admin itself (redirect stub, no nav item)", () => {
    h.pathname = "/admin";
    render(<Nav />);
    expect(activeLabels()).toEqual([]);
  });

  it("lights ONLY Cloud on /admin/cloud", () => {
    h.pathname = "/admin/cloud";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Cloud"]);
  });

  it("lights Authentication across the /admin/auth subtree", () => {
    h.pathname = "/admin/auth";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Authentication"]);
    cleanup();
    h.pathname = "/admin/auth/providers";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Authentication"]);
  });

  it("lights Advisors at its new /admin/advisors home", () => {
    h.pathname = "/admin/advisors";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Advisors"]);
  });

  it("lights Competitor Intel on /intel", () => {
    h.pathname = "/intel";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Competitor Intel"]);
  });

  it("keeps Competitor Intel lit across /intel/search and detail pages", () => {
    h.pathname = "/intel/search";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Competitor Intel"]);
    cleanup();
    h.pathname = "/intel/sources/8b2f1a4e-0000-4000-8000-000000000000";
    render(<Nav />);
    expect(activeLabels()).toEqual(["Competitor Intel"]);
  });
});
