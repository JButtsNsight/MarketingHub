import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboundMessageWithCampaign } from "@/lib/sms/repo";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { InboxTable } from "./InboxTable";

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

function message(
  over: Partial<InboundMessageWithCampaign> = {},
): InboundMessageWithCampaign {
  return {
    id: "in-1",
    phone_e164: "+15550000004",
    body: "Yes, what time works?",
    received_at: "2026-08-05T14:30:00Z",
    matched_recipient_id: "r7",
    matched_campaign_id: "c-3",
    handled: false,
    handled_by: null,
    handled_at: null,
    raw: {},
    campaign: { id: "c-3", name: "August recall" },
    ...over,
  };
}

describe("InboxTable", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("renders the reply with a UTC stamp, campaign link, and needs-reply badge", () => {
    render(<InboxTable messages={[message()]} />);
    expect(screen.getByText("2026-08-05 14:30 UTC")).toBeInTheDocument();
    expect(screen.getByText("+15550000004")).toBeInTheDocument();
    expect(screen.getByText("Yes, what time works?")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "August recall" }),
    ).toHaveAttribute("href", "/campaigns/c-3");
    expect(screen.getByText("needs reply")).toBeInTheDocument();
  });

  test("hides the campaign column when embedded on a campaign page", () => {
    render(<InboxTable messages={[message()]} showCampaign={false} />);
    expect(
      screen.queryByRole("link", { name: "August recall" }),
    ).not.toBeInTheDocument();
  });

  test("Mark handled PATCHes the inbox route and refreshes", async () => {
    const fetchFn = mockFetch(200, { message: message({ handled: true }) });
    const user = userEvent.setup();
    render(<InboxTable messages={[message()]} />);

    await user.click(screen.getByRole("button", { name: /mark handled/i }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/inbox/in-1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ handled: true });
    expect(refresh).toHaveBeenCalled();
  });

  test("a handled reply shows Reopen and PATCHes handled: false", async () => {
    const fetchFn = mockFetch(200, { message: message({ handled: false }) });
    const user = userEvent.setup();
    render(
      <InboxTable
        messages={[
          message({ handled: true, handled_by: "amy@nsight.example" }),
        ]}
      />,
    );

    expect(screen.getByText("handled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /reopen/i }));

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({
      handled: false,
    });
    expect(refresh).toHaveBeenCalled();
  });

  test("a failed PATCH surfaces an error and does not refresh", async () => {
    mockFetch(500, { error: "boom" });
    const user = userEvent.setup();
    render(<InboxTable messages={[message()]} />);

    await user.click(screen.getByRole("button", { name: /mark handled/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
