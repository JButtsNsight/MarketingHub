import { beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  RealtimeTokenInfo,
  SubscribeWithFallbackOptions,
} from "@/lib/realtime/client";
import { RealtimeInspector } from "./RealtimeInspector";

/**
 * The inspector talks to realtime ONLY through the foundation wrapper, so the
 * whole module is mocked: tests drive the captured onStatus/onEvent/onPresence
 * callbacks to simulate the socket, and inspect send/track calls.
 */
const mocks = vi.hoisted(() => {
  const captured: { options: SubscribeWithFallbackOptions | null } = {
    options: null,
  };
  const send = vi.fn<
    (event: string, payload: Record<string, unknown>) => Promise<string>
  >(async () => "ok");
  const track = vi.fn<
    (payload: Record<string, unknown>) => Promise<string>
  >(async () => "ok");
  const untrack = vi.fn<() => Promise<string>>(async () => "ok");
  const unsubscribe = vi.fn();
  const presenceState = vi.fn<() => Record<string, unknown[]>>(() => ({}));
  const subscribeWithFallback = vi.fn(
    (options: SubscribeWithFallbackOptions) => {
      captured.options = options;
      return Object.assign(() => unsubscribe(), {
        unsubscribe,
        send,
        track,
        untrack,
        presenceState,
      });
    },
  );
  const fetchRealtimeToken = vi.fn<() => Promise<RealtimeTokenInfo | null>>(
    async () => ({
      token: "jwt",
      expiresAtMs: Date.now() + 300_000,
      anonKey: "anon-key",
    }),
  );
  const getSocketState = vi.fn<() => string>(() => "uninitialized");
  const onSocketHeartbeat = vi.fn(() => () => {});
  return {
    captured,
    send,
    track,
    untrack,
    unsubscribe,
    presenceState,
    subscribeWithFallback,
    fetchRealtimeToken,
    getSocketState,
    onSocketHeartbeat,
  };
});

vi.mock("@/lib/realtime/client", () => ({
  DEFAULT_BROADCAST_EVENTS: ["change"] as readonly string[],
  subscribeWithFallback: mocks.subscribeWithFallback,
  fetchRealtimeToken: mocks.fetchRealtimeToken,
  getSocketState: mocks.getSocketState,
  onSocketHeartbeat: mocks.onSocketHeartbeat,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.captured.options = null;
  mocks.fetchRealtimeToken.mockResolvedValue({
    token: "jwt",
    expiresAtMs: Date.now() + 300_000,
    anonKey: "anon-key",
  });
  mocks.send.mockResolvedValue("ok");
  mocks.track.mockResolvedValue("ok");
  mocks.untrack.mockResolvedValue("ok");
  mocks.presenceState.mockReturnValue({});
  // The send-confirm gate is per browser session — start each test cold.
  window.sessionStorage.clear();
});

/** Render, wait for the token preflight to settle, and join the channel. */
async function renderAndJoin(user: ReturnType<typeof userEvent.setup>) {
  render(<RealtimeInspector userEmail="tester@nsightcare.com" />);
  expect(await screen.findByText("token: ok")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(mocks.subscribeWithFallback).toHaveBeenCalledTimes(1);
  const options = mocks.captured.options;
  expect(options).not.toBeNull();
  return options!;
}

describe("RealtimeInspector", () => {
  test("token failure renders the honest unreachable state", async () => {
    mocks.fetchRealtimeToken.mockResolvedValue(null);
    render(<RealtimeInspector userEmail="tester@nsightcare.com" />);

    const banner = await screen.findByText(/Realtime unreachable/);
    expect(banner).toHaveTextContent(
      "Realtime unreachable — ALB route/env not applied yet.",
    );
    expect(screen.getByText("token: unreachable")).toBeInTheDocument();
    // Preflight alone never opens a channel.
    expect(mocks.subscribeWithFallback).not.toHaveBeenCalled();
  });

  test("an unavailable channel also raises the unreachable banner", async () => {
    const user = userEvent.setup();
    const options = await renderAndJoin(user);
    expect(screen.queryByText(/Realtime unreachable/)).not.toBeInTheDocument();

    act(() => {
      options.onStatus?.("unavailable");
    });

    expect(
      screen.getByText(/Realtime unreachable — ALB route\/env not applied yet/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("rt-connection-status")).toHaveTextContent(
      "unavailable",
    );
  });

  test("joins via the wrapper and renders feed + presence from its events", async () => {
    const user = userEvent.setup();
    const options = await renderAndJoin(user);

    // Default topic + presence identity go through the wrapper untouched.
    expect(options.topic).toMatch(/^mh:inspector:/);
    expect(options.presence).toEqual({ key: "tester@nsightcare.com" });
    expect(options.broadcastEvents).toEqual(["change"]);

    act(() => {
      options.onStatus?.("live");
    });
    expect(screen.getByTestId("rt-connection-status")).toHaveTextContent(
      "live",
    );

    act(() => {
      options.onEvent?.("change", { table: "sms_campaigns", id: "42" });
    });
    // The broadcast lands in the message log (grid cell carries the full
    // payload in its title) and mirrors into the payload viewer.
    expect(screen.getByText("broadcast")).toBeInTheDocument();
    expect(
      screen.getByTitle('{"table":"sms_campaigns","id":"42"}'),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/sms_campaigns/).length).toBeGreaterThan(0);

    act(() => {
      options.onPresence?.({
        "tester@nsightcare.com": [{ email: "tester@nsightcare.com" }],
      });
    });
    expect(screen.getByText("tester@nsightcare.com")).toBeInTheDocument();
  });

  test("first send is confirm-gated per session; cancel sends nothing", async () => {
    const user = userEvent.setup();
    const options = await renderAndJoin(user);
    act(() => {
      options.onStatus?.("live");
    });

    // 1) First attempt opens the modal — nothing sent yet.
    await user.click(screen.getByRole("button", { name: "Send" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(mocks.send).not.toHaveBeenCalled();

    // 2) Cancelling keeps the gate closed: still nothing sent.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();

    // 3) The next attempt asks again (cancel never confirms the session).
    await user.click(screen.getByRole("button", { name: "Send" }));
    dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Send broadcast" }),
    );
    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith("change", { hello: "inspector" });
    });

    // 4) Confirmed for the session: subsequent sends skip the modal.
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledTimes(2);
    });
  });

  test("send is disabled until a channel is joined", async () => {
    render(<RealtimeInspector userEmail="tester@nsightcare.com" />);
    expect(await screen.findByText("token: ok")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  test("warns that non-mh topics fail the private-channel policy", async () => {
    const user = userEvent.setup();
    render(<RealtimeInspector userEmail="tester@nsightcare.com" />);
    expect(await screen.findByText("token: ok")).toBeInTheDocument();

    // Default mh:inspector:* topic — no warning.
    expect(
      screen.queryByText(/policies will refuse the join/),
    ).not.toBeInTheDocument();

    const topic = screen.getByLabelText("topic");
    await user.clear(topic);
    await user.type(topic, "public:lobby");

    expect(
      screen.getByText(/policies will refuse the join/),
    ).toBeInTheDocument();
  });
});
