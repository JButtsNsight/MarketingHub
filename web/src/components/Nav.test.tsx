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
      "Authentication",
      "Storage",
      "Edge Functions",
      "Realtime",
      "API Docs",
      "Advisors",
    ]);
  });

  it("exposes pg_cron / pgmq under an Integrations group", () => {
    const integrations = NAV_GROUPS.find((g) => g.label === "Integrations");
    expect(integrations).toBeDefined();
    expect(integrations!.items.map((i) => [i.label, i.href])).toEqual([
      ["Cron", "/integrations/cron"],
      ["Queues", "/integrations/queues"],
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
});
