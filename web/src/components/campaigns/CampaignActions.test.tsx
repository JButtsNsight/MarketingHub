import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { CampaignActions } from "./CampaignActions";

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

describe("CampaignActions", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("scheduled: pause and cancel are enabled, resume is disabled", () => {
    render(<CampaignActions campaignId="c1" status="scheduled" />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /resume/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
  });

  test("sending: pause and cancel are enabled, resume is disabled", () => {
    render(<CampaignActions campaignId="c1" status="sending" />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /resume/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
  });

  test("paused: resume and cancel are enabled, pause is disabled", () => {
    render(<CampaignActions campaignId="c1" status="paused" />);
    expect(screen.getByRole("button", { name: /pause/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /resume/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeEnabled();
  });

  test.each(["completed", "canceled"] as const)(
    "%s: every action is disabled",
    (status) => {
      render(<CampaignActions campaignId="c1" status={status} />);
      expect(screen.getByRole("button", { name: /pause/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /resume/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    },
  );

  test("pause PATCHes the campaign and refreshes the server page", async () => {
    const fetchFn = mockFetch(200, { campaign: { id: "c1", status: "paused" } });
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="sending" />);

    await user.click(screen.getByRole("button", { name: /pause/i }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/campaigns/c1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ action: "pause" });
    expect(refresh).toHaveBeenCalled();
  });

  test("resume PATCHes with the resume action", async () => {
    const fetchFn = mockFetch(200, { campaign: { id: "c1", status: "scheduled" } });
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="paused" />);

    await user.click(screen.getByRole("button", { name: /resume/i }));

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({
      action: "resume",
    });
    expect(refresh).toHaveBeenCalled();
  });

  test("cancel sits behind a confirm that warns an in-flight message may still send", async () => {
    const fetchFn = mockFetch(200, { campaign: { id: "c1", status: "canceled" } });
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="sending" />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(
      /an in-flight message may still send/i,
    );
    // Declined → nothing happens.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  test("confirmed cancel PATCHes with the cancel action and refreshes", async () => {
    const fetchFn = mockFetch(200, { campaign: { id: "c1", status: "canceled" } });
    vi.spyOn(window, "confirm").mockImplementation(() => true);
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="scheduled" />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string)).toEqual({
      action: "cancel",
    });
    expect(refresh).toHaveBeenCalled();
  });

  test("a 409 (stale status) still refreshes so the UI shows the fresh state", async () => {
    mockFetch(409, { error: "Campaign is not in a state that allows pause" });
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="sending" />);

    await user.click(screen.getByRole("button", { name: /pause/i }));

    expect(refresh).toHaveBeenCalled();
  });

  test("an unexpected failure shows an error and does not refresh", async () => {
    mockFetch(500, { error: "boom" });
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="sending" />);

    await user.click(screen.getByRole("button", { name: /pause/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("a network-level failure shows an error, no unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const user = userEvent.setup();
    render(<CampaignActions campaignId="c1" status="sending" />);

    await user.click(screen.getByRole("button", { name: /pause/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /network error — please try again/i,
    );
    expect(refresh).not.toHaveBeenCalled();
    // The busy flag resets so the user can retry.
    expect(screen.getByRole("button", { name: /pause/i })).toBeEnabled();
  });
});
