import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ pathname: "/overview" }));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
}));

import { NAV_GROUPS, Nav, navGroupsFor } from "./Nav";

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
      ["Logs", "/logs"],
      ["Infrastructure", "/infrastructure"],
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

  it("keeps Project down to Settings", () => {
    const project = NAV_GROUPS.find((g) => g.label === "Project");
    expect(project).toBeDefined();
    expect(project!.items.map((i) => [i.label, i.href])).toEqual([
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

  it("routes Reports on Platform and Logs under Admin", () => {
    const platform = NAV_GROUPS.find((g) => g.label === "Platform")!;
    const admin = NAV_GROUPS.find((g) => g.label === "Admin")!;
    expect(
      Object.fromEntries(platform.items.map((i) => [i.label, i.href]))["Reports"],
    ).toBe("/reports");
    expect(
      Object.fromEntries(admin.items.map((i) => [i.label, i.href]))["Logs"],
    ).toBe("/logs");
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
    render(<Nav admin />);
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
    render(<Nav admin />);
    expect(activeLabels()).toEqual([]);
  });

  it("lights ONLY Cloud on /admin/cloud", () => {
    h.pathname = "/admin/cloud";
    render(<Nav admin />);
    expect(activeLabels()).toEqual(["Cloud"]);
  });

  it("lights Authentication across the /admin/auth subtree", () => {
    h.pathname = "/admin/auth";
    render(<Nav admin />);
    expect(activeLabels()).toEqual(["Authentication"]);
    cleanup();
    h.pathname = "/admin/auth/providers";
    render(<Nav admin />);
    expect(activeLabels()).toEqual(["Authentication"]);
  });

  it("lights Advisors at its new /admin/advisors home", () => {
    h.pathname = "/admin/advisors";
    render(<Nav admin />);
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

describe("Nav admin visibility — display filter only (routes enforce)", () => {
  it("navGroupsFor(false) drops ONLY the Admin group", () => {
    expect(navGroupsFor(false).map((g) => g.label)).toEqual([
      undefined,
      "Platform",
      "Integrations",
      "Marketing",
      "Project",
    ]);
  });

  it("navGroupsFor(true) is the full NAV_GROUPS", () => {
    expect(navGroupsFor(true)).toEqual(NAV_GROUPS);
  });

  it("hides the Admin group by default (fail-closed display)", () => {
    h.pathname = "/overview";
    render(<Nav />);
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByRole("link", { name: /authentication/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /logs/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /infrastructure/i })).toBeNull();
    // Everything else identical — the other groups stay.
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sms campaigns/i })).toBeInTheDocument();
  });

  it("shows the Admin group for admins", () => {
    h.pathname = "/overview";
    render(<Nav admin />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /authentication/i })).toHaveAttribute(
      "href",
      "/admin/auth",
    );
    expect(screen.getByRole("link", { name: /infrastructure/i })).toHaveAttribute(
      "href",
      "/infrastructure",
    );
  });

  it("an explicit groups prop overrides the admin filter", () => {
    h.pathname = "/overview";
    render(<Nav groups={NAV_GROUPS} />);
    expect(screen.getByRole("link", { name: /authentication/i })).toBeInTheDocument();
  });
});
