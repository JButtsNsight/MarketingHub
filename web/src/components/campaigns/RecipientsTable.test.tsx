import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SmsCampaignRecipient } from "@/lib/sms/schema";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { RecipientsTable } from "./RecipientsTable";

function recipient(
  id: string,
  overrides: Partial<SmsCampaignRecipient> = {},
): SmsCampaignRecipient {
  return {
    id,
    campaign_id: "c1",
    monday_item_id: "900100",
    name: "Jane Doe",
    first_name: "Jane",
    phone_e164: "+15559234567",
    rendered_text: "Hi Jane, time for a visit.",
    status: "pending",
    attempts: 0,
    send_after: "2026-08-03T15:30:00Z",
    claimed_at: null,
    claim_expires_at: null,
    st_message_id: null,
    st_credits: null,
    last_error: null,
    created_at: "2026-07-22T12:00:00Z",
    updated_at: "2026-07-22T12:00:00Z",
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("RecipientsTable", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders name, mono phone, status badge, attempts, and mono message id", () => {
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[
          recipient("r1", {
            status: "sent",
            attempts: 2,
            st_message_id: "st-msg-77",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    const phone = screen.getByText("+15559234567");
    expect(phone.closest(".mono, td.mono")).not.toBeNull();
    expect(screen.getByText("sent")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    const msgId = screen.getByText("st-msg-77");
    expect(msgId.closest(".mono, td.mono")).not.toBeNull();
  });

  test("humanizes underscored statuses in the badge", () => {
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );
    expect(screen.getByText("failed ambiguous")).toBeInTheDocument();
  });

  test("truncates a long last_error but keeps the full text as the title", () => {
    const longError = "x".repeat(120);
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed", last_error: longError })]}
      />,
    );
    const cell = screen.getByTitle(longError);
    expect(cell.textContent!.length).toBeLessThan(longError.length);
    expect(cell.textContent).toMatch(/…$/);
  });

  test("review buttons appear ONLY on failed_ambiguous rows", () => {
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[
          recipient("r1", { status: "failed_ambiguous", name: "Ambi Guous" }),
          recipient("r2", { status: "failed", name: "Flat Failed" }),
          recipient("r3", { status: "sent", name: "Sent Fine" }),
        ]}
      />,
    );
    expect(screen.getAllByRole("button", { name: /retry/i })).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /mark failed/i }),
    ).toHaveLength(1);
    const ambiguousRow = screen.getByText("Ambi Guous").closest("tr")!;
    expect(
      within(ambiguousRow).getByRole("button", { name: /retry/i }),
    ).toBeInTheDocument();
  });

  test("Retry PATCHes the recipient review route and refreshes", async () => {
    const fetchFn = mockFetch(200, {
      recipient: { id: "r1", status: "pending" },
      campaignStatus: "sending",
    });
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/campaigns/c1/recipients/r1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ action: "retry" });
    expect(refresh).toHaveBeenCalled();
  });

  test("Mark failed PATCHes with mark_failed and refreshes", async () => {
    const fetchFn = mockFetch(200, { recipient: { id: "r1", status: "failed" } });
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /mark failed/i }));

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({
      action: "mark_failed",
    });
    expect(refresh).toHaveBeenCalled();
  });

  test("a 409 (already resolved elsewhere) still refreshes", async () => {
    mockFetch(409, { error: "Recipient is not in a retryable state" });
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(refresh).toHaveBeenCalled();
    // Not a canceled campaign — no scary message, the refresh tells the story.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("an unexpected failure shows an error and does not refresh", async () => {
    mockFetch(500, { error: "boom" });
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("a network-level failure shows an error, no unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /network error — please try again/i,
    );
    expect(refresh).not.toHaveBeenCalled();
    // The busy flag resets so the user can retry.
    expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
  });

  test("renders an empty message when the campaign has no recipients", () => {
    render(
      <RecipientsTable campaignId="c1" campaignStatus="sending" recipients={[]} />,
    );
    expect(screen.getByText(/no recipients/i)).toBeInTheDocument();
  });

  test("canceled campaign: Retry is hidden, Mark failed remains", () => {
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="canceled"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
    // Resolving the bookkeeping is still valid on a canceled campaign.
    expect(
      screen.getByRole("button", { name: /mark failed/i }),
    ).toBeInTheDocument();
  });

  test("a canceled-campaign 409 explains retries are closed and refreshes", async () => {
    // The client's status prop can be stale (campaign canceled after page
    // load) — the server 409s and the UI must say why.
    mockFetch(409, { error: "campaign-canceled" });
    const user = userEvent.setup();
    render(
      <RecipientsTable
        campaignId="c1"
        campaignStatus="sending"
        recipients={[recipient("r1", { status: "failed_ambiguous" })]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Campaign is canceled — recipients can no longer be retried.",
    );
    expect(refresh).toHaveBeenCalled();
  });
});
