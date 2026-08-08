import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => {
  /**
   * Stand-in for the foundation lib's class — the page's `instanceof` check
   * runs against the mocked module, so this class IS the one it sees.
   */
  class GoTrueUnavailableError extends Error {
    constructor(detail: string) {
      super(`[console:gotrue] gotrue unreachable: ${detail}`);
      this.name = "GoTrueUnavailableError";
    }
  }
  return {
    requireMarketingUser: vi.fn(),
    getSettings: vi.fn(),
    listSsoProviders: vi.fn(),
    gotrueHealth: vi.fn(),
    GoTrueUnavailableError,
  };
});

// The page is gated server-side on the marketing group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// requireMarketingUser.test.ts). One test below verifies the gate is enforced
// BEFORE any GoTrue read happens.
vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));

// Builder-B contract: the Config page consumes the foundation lib only via
// vi.mock("@/lib/console/gotrue") — no real fetch ever runs in these tests.
vi.mock("@/lib/console/gotrue", () => ({
  GoTrueUnavailableError: h.GoTrueUnavailableError,
  getSettings: h.getSettings,
  listSsoProviders: h.listSsoProviders,
  gotrueHealth: h.gotrueHealth,
}));

import AuthConfigPage from "./page";

const AMY = { email: "amy@nsight.example", name: "Amy", groups: ["marketing"] };

const SETTINGS = {
  external: {
    // Deliberately unsorted: the page must render enabled-first.
    google: false,
    email: true,
    anonymous_users: false,
    github: false,
    phone: false,
  },
  disable_signup: true,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  sms_provider: "",
  saml_enabled: true,
};

const HEALTH = { version: "v2.186.0", name: "GoTrue" };

const SAML_PROVIDER = {
  id: "3c1e9d5a-6a51-4b3e-9f1a-000000000001",
  resource_id: "nsight-workspace",
  disabled: false,
  saml: {
    entity_id: "https://accounts.google.com/o/saml2?idpid=C00n27oyt",
    metadata_url: "https://accounts.google.com/o/saml2/metadata",
  },
  domains: [{ domain: "nsight.example" }],
  created_at: "2026-08-01T12:00:00Z",
};

describe("auth/providers/page.tsx (server component, display-only)", () => {
  beforeEach(() => {
    h.requireMarketingUser.mockReset().mockResolvedValue(AMY);
    h.getSettings.mockReset().mockResolvedValue(SETTINGS);
    h.listSsoProviders.mockReset().mockResolvedValue([]);
    h.gotrueHealth.mockReset().mockResolvedValue(HEALTH);
  });

  test("renders provider flags enabled-first, posture rows, and the version chip behind the gate", async () => {
    render(await AuthConfigPage());

    expect(h.requireMarketingUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Auth configuration", level: 1 }),
    ).toBeInTheDocument();
    // Version chip from GET /health.
    expect(screen.getByText("GoTrue v2.186.0")).toBeInTheDocument();

    // Enabled-first grouping: `email` (the only enabled flag) sits in the
    // Enabled row; the disabled flags land in the Disabled row.
    const enabledRow = screen
      .getByText("Enabled providers")
      .closest(".kv-row") as HTMLElement;
    expect(within(enabledRow).getByText("email")).toBeInTheDocument();
    const disabledRow = screen
      .getByText("Disabled providers")
      .closest(".kv-row") as HTMLElement;
    expect(
      within(disabledRow).getByText(/anonymous_users, github, google, phone/),
    ).toBeInTheDocument();

    // Signup / autoconfirm / SMS posture, verbatim-honest.
    expect(screen.getByText("Disabled (disable_signup)")).toBeInTheDocument();
    expect(screen.getByText("none configured")).toBeInTheDocument();
    expect(screen.getAllByText("Off").length).toBe(2);
  });

  test("SSO section renders the honest pending-SAML empty state when no provider exists", async () => {
    render(await AuthConfigPage());

    expect(
      screen.getByRole("heading", { name: "No SSO providers" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/external SAML deliverable .* still pending/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Wave 3.s blocked remainder/i),
    ).toBeInTheDocument();
    // saml_enabled flag still shown truthfully alongside the empty list.
    expect(screen.getByText("Enabled (saml_enabled)")).toBeInTheDocument();
  });

  test("SSO section lists a registered provider read-only", async () => {
    h.listSsoProviders.mockResolvedValue([SAML_PROVIDER]);
    render(await AuthConfigPage());

    expect(screen.queryByText("No SSO providers")).not.toBeInTheDocument();
    expect(
      screen.getByText("https://accounts.google.com/o/saml2?idpid=C00n27oyt"),
    ).toBeInTheDocument();
    expect(screen.getByText("nsight.example")).toBeInTheDocument();
    expect(screen.getByText("nsight-workspace")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  test("email-templates section is an env reference (names only) and MFA section is honestly static", async () => {
    render(await AuthConfigPage());

    // All six auth-flow template/subject env var names, no values.
    for (const flow of [
      "INVITE",
      "CONFIRMATION",
      "RECOVERY",
      "EMAIL_CHANGE",
      "MAGIC_LINK",
      "REAUTHENTICATION",
    ]) {
      expect(
        screen.getByText(`GOTRUE_MAILER_TEMPLATES_${flow}`),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`GOTRUE_MAILER_SUBJECTS_${flow}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByText(/no read API for them, so template content is not viewable/i),
    ).toBeInTheDocument();

    // MFA: per-user factors live in the Users detail; global policy is env-only.
    expect(screen.getByText(/GOTRUE_MFA_\*/)).toBeInTheDocument();
    expect(screen.getByText(/Users tab/)).toBeInTheDocument();
    expect(
      screen.getByText(/no admin endpoint that reads back its runtime config/i),
    ).toBeInTheDocument();
  });

  test("display-only guarantee: no mutation affordance in any loaded state", async () => {
    h.listSsoProviders.mockResolvedValue([SAML_PROVIDER]);
    const { container } = render(await AuthConfigPage());

    // Hard Wave 3-partial constraint: zero buttons, forms, or inputs — the
    // page must never grow a toggle/create/edit affordance.
    expect(
      container.querySelectorAll(
        "button, form, input, select, textarea, [role='switch'], [contenteditable='true']",
      ).length,
    ).toBe(0);
  });

  test("GoTrueUnavailableError → honest unreachable state, no config sections", async () => {
    h.getSettings.mockRejectedValue(
      new h.GoTrueUnavailableError("SUPABASE_URL is not configured"),
    );
    render(await AuthConfigPage());

    expect(
      screen.getByRole("heading", { name: "GoTrue unreachable" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing else in the console is affected\./),
    ).toBeInTheDocument();
    // No section pretends to hold data.
    expect(screen.queryByText("Sign-in providers")).not.toBeInTheDocument();
    expect(screen.queryByText(/GOTRUE_MAILER/)).not.toBeInTheDocument();
    expect(screen.queryByText("GoTrue v2.186.0")).not.toBeInTheDocument();
  });

  test("non-unavailable lib failure → stripped, actionable error (key misconfig stays a real answer)", async () => {
    h.getSettings.mockRejectedValue(
      new Error(
        "[console:gotrue] get-settings failed: 403 not_admin — GoTrue accepted the JWT but its role claim is not an admin role: SUPABASE_SERVICE_ROLE_KEY on this server is not the service-role key (it must carry role=service_role)",
      ),
    );
    render(await AuthConfigPage());

    expect(
      screen.getByRole("heading", { name: "Configuration unreadable" }),
    ).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/^403 not_admin/);
    expect(alert.textContent).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    // The [console:gotrue] plumbing prefix never reaches the user.
    expect(screen.queryByText(/\[console:gotrue\]/)).not.toBeInTheDocument();
    // It is rendered as a real answer, not as unreachable.
    expect(screen.queryByText("GoTrue unreachable")).not.toBeInTheDocument();
  });

  test("gate failure (redirect) propagates before any GoTrue read", async () => {
    // requireMarketingUser redirects to /login on AuthError; redirect() throws.
    h.requireMarketingUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(AuthConfigPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.getSettings).not.toHaveBeenCalled();
    expect(h.listSsoProviders).not.toHaveBeenCalled();
    expect(h.gotrueHealth).not.toHaveBeenCalled();
  });
});
