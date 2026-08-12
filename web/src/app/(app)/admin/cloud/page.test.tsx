import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireAdminUser: vi.fn(),
}));

// The page is gated server-side on the admin group; stub the gate so the
// render tests focus on the page body (the gate itself is unit-tested in
// auth.test.ts). Tests below verify the gate is enforced BEFORE any content
// renders, for both the signed-out and the non-admin outcome.
vi.mock("@/lib/requireAdminUser", () => ({
  requireAdminUser: h.requireAdminUser,
}));

import CloudFeaturesPage from "./page";

const AMY = {
  email: "amy@nsight.example",
  name: "Amy",
  groups: ["marketing", "marketinghub-admins"],
};

// The five cloud-only features this panel must declare N/A — plus the AI
// Assistant (our live equivalent since 2026-08-11), asserted separately below.
const CLOUD_ONLY_FEATURES = [
  "Branching",
  "Read replicas",
  "Custom domains",
  "PrivateLink",
  "SOC 2",
] as const;

describe("admin/cloud/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireAdminUser.mockReset().mockResolvedValue({ ok: true, user: AMY });
  });

  test("renders the honest N/A panel behind the gate", async () => {
    render(await CloudFeaturesPage());

    expect(h.requireAdminUser).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Cloud Features", level: 1 }),
    ).toBeInTheDocument();

    // Every cloud-only feature appears in the status ledger with an explicit
    // N/A — no aspirational toggles.
    for (const feature of CLOUD_ONLY_FEATURES) {
      expect(screen.getByRole("cell", { name: feature })).toBeInTheDocument();
    }
    expect(screen.getAllByText("N/A — control plane")).toHaveLength(
      CLOUD_ONLY_FEATURES.length,
    );

    // Each feature has a "not available here" row AND a coverage story.
    for (const feature of CLOUD_ONLY_FEATURES) {
      expect(
        screen.getByText(new RegExp(`${feature} — not available here`)),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByText(/Private subnets already do PrivateLink's job/),
    ).toBeInTheDocument();
    expect(screen.getByText(/There is nothing to white-label/)).toBeInTheDocument();
    expect(
      screen.getByText(/restoring a copy from pgBackRest\/pg_dumpall/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a vanilla Postgres standby can be fed from the existing WAL archive/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cognito\/ALB authentication, pgaudit \+ the console query audit/),
    ).toBeInTheDocument();
  });

  test("AI Assistant declares our live equivalent, not the stock Studio one", async () => {
    render(await CloudFeaturesPage());

    expect(screen.getByRole("cell", { name: "AI Assistant" })).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "our equivalent live — /sql" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI Assistant — our equivalent is live" }),
    ).toBeInTheDocument();
    // The W7 skip is FLIPPED — no stale skipped-pending-sign-off copy anywhere.
    expect(screen.queryByText(/skipped pending sign-off/i)).not.toBeInTheDocument();
    // Honest scope: our equivalent, not stock Studio's assistant.
    expect(
      screen.getByText(
        /headless-claude gateway \(direct Anthropic, BAA\) — not stock Studio's assistant/,
      ),
    ).toBeInTheDocument();
    // The non-negotiables stay on the record: metadata-only egress, propose-only.
    expect(
      screen.getByText(/row data and query results never leave/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing auto-executes/)).toBeInTheDocument();
    // Stock Studio's assistant stays off — the no-BAA decision stands.
    expect(
      screen.getByText(/No OPENAI_API_KEY anywhere — the no-BAA decision stands/),
    ).toBeInTheDocument();
    // And honest self-hosted availability (BYO key), never "cloud-only".
    expect(
      screen.getByRole("cell", { name: "partial (BYO OpenAI key)" }),
    ).toBeInTheDocument();
  });

  test("page is static — never fetches, no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      render(await CloudFeaturesPage());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("signed-in non-admin gets the terse 403 panel, no content", async () => {
    h.requireAdminUser.mockResolvedValue({ ok: false });
    render(await CloudFeaturesPage());

    expect(screen.getByRole("heading", { name: "403" })).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent).toBe("Admin access required.");
    expect(screen.queryByText("Cloud Features")).not.toBeInTheDocument();
  });

  test("signed-out gate failure (redirect) propagates before any content renders", async () => {
    // requireAdminUser redirects to /login on 401; redirect() throws.
    h.requireAdminUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(CloudFeaturesPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
