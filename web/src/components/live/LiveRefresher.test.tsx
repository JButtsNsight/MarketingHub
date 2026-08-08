import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

/**
 * The foundation wrapper is mocked wholesale: `h.status` is what the hook
 * reports and `h.calls` captures every (topic, options) pair so tests can
 * hand-fire `change` events through the captured `onEvent`.
 */
const h = vi.hoisted(() => ({
  status: "connecting" as string,
  calls: [] as Array<{
    topic: unknown;
    options: {
      onEvent?: (
        event: string,
        payload: Record<string, unknown>,
        topic: string,
      ) => void;
    };
  }>,
  refresh: vi.fn(),
}));

vi.mock("@/lib/realtime/client", () => ({
  useLiveTopic: (topic: unknown, options = {}) => {
    h.calls.push({ topic, options });
    return h.status;
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));

import {
  LiveRefresher,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MIN_INTERVAL_MS,
} from "./LiveRefresher";

/** Fire one `change` broadcast through the latest captured subscription. */
function emitChange(topic = "mh:inbox") {
  act(() => {
    h.calls.at(-1)!.options.onEvent?.("change", { id: "x" }, topic);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("LiveRefresher", () => {
  beforeEach(() => {
    h.status = "connecting";
    h.calls.length = 0;
    h.refresh.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("passes the topic(s) through to the wrapper unchanged", () => {
    render(<LiveRefresher topic={["mh:campaign:c1", "mh:inbox"]} />);
    expect(h.calls[0].topic).toEqual(["mh:campaign:c1", "mh:inbox"]);
  });

  test("renders nothing while connecting and when unavailable (fallback)", () => {
    h.status = "connecting";
    const { container, unmount } = render(<LiveRefresher topic="mh:inbox" />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    h.status = "unavailable";
    const second = render(<LiveRefresher topic="mh:inbox" />);
    expect(second.container).toBeEmptyDOMElement();
    advance(60_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  test("shows the small Live badge only when live", () => {
    h.status = "live";
    render(<LiveRefresher topic="mh:inbox" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  test("a change event refreshes after the 2s debounce, not before", () => {
    h.status = "live";
    render(<LiveRefresher topic="mh:inbox" />);
    emitChange();
    advance(REFRESH_DEBOUNCE_MS - 1);
    expect(h.refresh).not.toHaveBeenCalled();
    advance(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  test("a burst of events coalesces into ONE refresh", () => {
    h.status = "live";
    render(<LiveRefresher topic="mh:inbox" />);
    for (let i = 0; i < 5; i += 1) emitChange();
    advance(REFRESH_DEBOUNCE_MS);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    advance(60_000);
    expect(h.refresh).toHaveBeenCalledTimes(1); // nothing else scheduled
  });

  test("refreshes are at least 5s apart under a steady event stream", () => {
    h.status = "live";
    render(<LiveRefresher topic="mh:inbox" />);

    emitChange();
    advance(REFRESH_DEBOUNCE_MS); // refresh #1 at t=2s
    expect(h.refresh).toHaveBeenCalledTimes(1);

    emitChange(); // immediately after refresh #1 -> throttled to t=7s
    advance(REFRESH_MIN_INTERVAL_MS - 1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    advance(1);
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  test("unmount cancels the pending refresh", () => {
    h.status = "live";
    const { unmount } = render(<LiveRefresher topic="mh:inbox" />);
    emitChange();
    unmount();
    advance(60_000);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
