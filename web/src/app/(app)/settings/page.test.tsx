import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
  // Request cookie seen by getPreviewPersona (server side, via next/headers).
  cookie: null as string | null,
}));

// The page is gated server-side on the marketing group; stub the gate so these
// render tests focus on the page body (the gate itself is unit-tested in
// requireMarketingUser.test.ts).
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

// next/headers exists only inside a Next request scope; mock it (auth.test.ts
// pattern) so getPreviewPersona can resolve the shim persona under test.
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name.toLowerCase() === "cookie" ? h.cookie : null,
    }),
}));

import SettingsPage from "./page";

const ENV_KEYS = [
  "MONDAY_API_TOKEN",
  "SIMPLETEXTING_WEBHOOK_TOKEN",
  "SIMPLETEXTING_API_TOKEN",
  "PREVIEW_AUTH",
] as const;

describe("settings/page.tsx (server component)", () => {
  const OLD = { ...process.env };

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    h.cookie = null;
    h.requireMarketingUser.mockReset();
    h.requireMarketingUser.mockResolvedValue({
      email: "amy@nsight.example",
      name: "Amy",
      groups: ["marketing"],
    });
  });

  afterEach(() => {
    process.env = { ...OLD };
    // PersonaSwitch reads document.cookie (jsdom persists it across tests).
    document.cookie = "mh-preview-persona=; path=/; max-age=0";
  });

  test("renders an SMS Campaigns section with unconfigured chips", async () => {
    render(await SettingsPage());
    expect(screen.getByText(/sms campaigns/i)).toBeInTheDocument();
    expect(screen.getByText(/monday\.com api token/i)).toBeInTheDocument();
    expect(
      screen.getByText(/simpletexting webhook token/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/simpletexting send token/i)).toBeInTheDocument();
    // Web-task tokens unset -> "not set"; the send token lives on the worker
    // task, whose env the web task cannot read — the chip must NOT assert the
    // secret is configured, only say where to verify it.
    expect(screen.getAllByText(/not set/i).length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(
        /managed on the worker task — verify via the worker log heartbeat or Secrets Manager/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/configured on the worker task/i),
    ).not.toBeInTheDocument();
  });

  test("shows configured chips (booleans only, never values) when env is set", async () => {
    process.env.MONDAY_API_TOKEN = "monday-secret-value";
    process.env.SIMPLETEXTING_WEBHOOK_TOKEN = "hook-secret-value";
    process.env.SIMPLETEXTING_API_TOKEN = "send-secret-value";
    const { container } = render(await SettingsPage());
    expect(screen.getAllByText(/^configured/i).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(container.textContent).not.toContain("secret-value");
  });

  test("shim off → 'off' chip, no persona chip or flip control", async () => {
    render(await SettingsPage());
    expect(screen.getByText("off")).toBeInTheDocument();
    expect(screen.queryByText(/persona:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view as/i })).not.toBeInTheDocument();
  });

  test("shim on, admin persona → 'persona: admin' chip + view-as-member flip", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    render(await SettingsPage());
    expect(screen.getByText("on")).toBeInTheDocument();
    expect(screen.getByText("persona: admin")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View as member" }),
    ).toBeInTheDocument();
  });

  test("demote cookie → 'persona: member' chip + back-to-admin flip", async () => {
    process.env.PREVIEW_AUTH = "marketing,marketinghub-admins";
    h.cookie = "mh-preview-persona=member";
    document.cookie = "mh-preview-persona=member; path=/";
    render(await SettingsPage());
    expect(screen.getByText("persona: member")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to admin" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("persona: admin")).not.toBeInTheDocument();
  });

  test("shim never granted admin → member chip, NO restore control (nothing to restore)", async () => {
    process.env.PREVIEW_AUTH = "marketing";
    render(await SettingsPage());
    expect(screen.getByText("persona: member")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
