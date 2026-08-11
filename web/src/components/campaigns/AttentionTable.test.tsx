import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttentionRecipient } from "@/lib/sms/repo";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { AttentionTable } from "./AttentionTable";

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

function row(over: Partial<AttentionRecipient> = {}): AttentionRecipient {
  return {
    id: "r1",
    campaign_id: "c1",
    monday_item_id: null,
    name: "Jane Doe",
    first_name: "Jane",
    phone_e164: "+15559234567",
    rendered_text: "Hi Jane",
    status: "failed_ambiguous",
    attempts: 1,
    send_after: "2026-08-03T15:30:00Z",
    send_timezone: null,
    claimed_at: null,
    claim_expires_at: null,
    st_message_id: null,
    st_credits: null,
    last_error: "timeout",
    monday_synced_at: null,
    monday_synced_status: null,
    created_at: "2026-08-03T15:00:00Z",
    updated_at: "2026-08-03T15:31:00Z",
    campaign: { id: "c1", name: "August recall", status: "sending" },
    ...over,
  };
}

describe("AttentionTable", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("ambiguous rows offer Retry, Mark sent, and Mark failed", () => {
    render(<AttentionTable rows={[row()]} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark sent/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark failed/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "August recall" })).toHaveAttribute(
      "href",
      "/campaigns/c1",
    );
  });

  test("failed rows offer only Retry; undelivered rows are informational", () => {
    render(
      <AttentionTable
        rows={[
          row({ id: "r2", status: "failed" }),
          row({ id: "r3", status: "undelivered", phone_e164: "+15550000009" }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /mark sent/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /mark failed/i }),
    ).not.toBeInTheDocument();
  });

  test("Retry is never offered inside a canceled campaign; Mark sent/failed remain", () => {
    render(
      <AttentionTable
        rows={[
          row({ campaign: { id: "c1", name: "Old blast", status: "canceled" } }),
        ]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark sent/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /mark failed/i }),
    ).toBeInTheDocument();
  });

  test("Mark sent PATCHes the recipient review route and refreshes", async () => {
    const fetchFn = mockFetch(200, { recipient: { id: "r1", status: "sent" } });
    const user = userEvent.setup();
    render(<AttentionTable rows={[row()]} />);

    await user.click(screen.getByRole("button", { name: /mark sent/i }));

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/campaigns/c1/recipients/r1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ action: "mark_sent" });
    expect(refresh).toHaveBeenCalled();
  });

  test("a 409 (someone else resolved it first) still refreshes silently", async () => {
    mockFetch(409, { error: "Recipient is not awaiting manual review" });
    const user = userEvent.setup();
    render(<AttentionTable rows={[row()]} />);

    await user.click(screen.getByRole("button", { name: /mark failed/i }));

    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("a server error surfaces and does not refresh", async () => {
    mockFetch(500, { error: "boom" });
    const user = userEvent.setup();
    render(<AttentionTable rows={[row()]} />);

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/retry action failed/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("empty queue shows the calm empty state", () => {
    render(<AttentionTable rows={[]} />);
    expect(screen.getByText("Nothing needs attention.")).toBeInTheDocument();
  });
});
