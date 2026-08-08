// jsdom environment (default): the module is browser-only and reads
// window.location.origin; @supabase/supabase-js is fully mocked.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: h.createClient,
}));

import * as realtime from "./client";
import {
  CONNECT_TIMEOUT_MS,
  RETRY_DELAY_MS,
  __resetRealtimeForTests,
  fetchRealtimeToken,
  getSocketState,
  onSocketHeartbeat,
  subscribeWithFallback,
  useLiveTopic,
} from "./client";

type Binding = {
  type: string;
  filter: Record<string, unknown>;
  cb: (message?: unknown) => void;
};

function makeFakeChannel(topic: string) {
  const bindings: Binding[] = [];
  const channel = {
    topic,
    bindings,
    subscribeCb: undefined as ((status: string) => void) | undefined,
    on: vi.fn((type: string, filter: Record<string, unknown>, cb: Binding["cb"]) => {
      bindings.push({ type, filter, cb });
      return channel;
    }),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      channel.subscribeCb = cb;
      return channel;
    }),
    send: vi.fn(async () => "ok"),
    track: vi.fn(async () => "ok"),
    untrack: vi.fn(async () => "ok"),
    presenceState: vi.fn(() => ({ "user-1": [{ online: true }] })),
    unsubscribe: vi.fn(async () => "ok"),
  };
  return channel;
}
type FakeChannel = ReturnType<typeof makeFakeChannel>;

function makeFakeClient() {
  const channels: FakeChannel[] = [];
  const client = {
    channels,
    channel: vi.fn((topic: string) => {
      const ch = makeFakeChannel(topic);
      channels.push(ch);
      return ch;
    }),
    removeChannel: vi.fn(async () => "ok"),
    realtime: {
      onHeartbeat: vi.fn(),
      connectionState: vi.fn(() => "open"),
      disconnect: vi.fn(async () => "ok"),
    },
  };
  return client;
}
type FakeClient = ReturnType<typeof makeFakeClient>;

function tokenBody() {
  return {
    token: "user-jwt-1",
    expiresAtMs: Date.now() + 300_000,
    anonKey: "test-anon-key",
  };
}

/** Stub the token endpoint. `ok:false` == unflagged 503 / no session. */
function stubTokenFetch(
  kind: { ok: true; body?: () => unknown } | { ok: false } | "reject",
) {
  const fetchMock = vi.fn(async (input: unknown) => {
    expect(String(input)).toBe("/api/realtime/token");
    if (kind === "reject") throw new TypeError("network down");
    return {
      ok: kind.ok,
      status: kind.ok ? 200 : 503,
      json: async () => (kind.ok ? (kind.body ?? tokenBody)() : { reason: "unflagged" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Flush pending microtasks (token fetch -> json -> client creation -> attach).
 * Plain awaits: microtasks are real even under fake timers, and each turn lets
 * one more level of the pending async chain progress.
 */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

let fakeClient: FakeClient;

beforeEach(() => {
  __resetRealtimeForTests();
  h.createClient.mockReset();
  fakeClient = makeFakeClient();
  h.createClient.mockReturnValue(fakeClient);
  vi.useFakeTimers();
});

afterEach(() => {
  __resetRealtimeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchRealtimeToken", () => {
  test("returns null (never throws) on 503 / network failure / bad shape", async () => {
    stubTokenFetch({ ok: false });
    expect(await fetchRealtimeToken()).toBeNull();

    stubTokenFetch("reject");
    expect(await fetchRealtimeToken()).toBeNull();

    stubTokenFetch({ ok: true, body: () => ({ nope: true }) });
    expect(await fetchRealtimeToken()).toBeNull();
  });

  test("caches until 60s before expiry, then refetches", async () => {
    const fetchMock = stubTokenFetch({ ok: true });
    expect((await fetchRealtimeToken())?.token).toBe("user-jwt-1");
    await fetchRealtimeToken();
    expect(fetchMock).toHaveBeenCalledTimes(1); // served from cache

    // Cross the refresh margin (300s TTL - 60s margin = 240s).
    await vi.advanceTimersByTimeAsync(241_000);
    await fetchRealtimeToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("client factory (internal singleton)", () => {
  test("derives the realtime URL from the SAME app origin + anon apikey", async () => {
    stubTokenFetch({ ok: true });
    const statuses: string[] = [];
    subscribeWithFallback({
      topic: "mh:inbox",
      onStatus: (s) => statuses.push(s),
    });
    await flush();

    expect(h.createClient).toHaveBeenCalledTimes(1);
    const [url, key, opts] = h.createClient.mock.calls[0];
    expect(url).toBe(window.location.origin); // wss derives from this base
    expect(key).toBe("test-anon-key");
    expect(opts.realtime.heartbeatIntervalMs).toBe(25_000);
    // accessToken re-runs each heartbeat and serves the (cached) user JWT.
    expect(typeof opts.accessToken).toBe("function");
    await expect(opts.accessToken()).resolves.toBe("user-jwt-1");
  });

  test("the raw client is NEVER exported (only wrapper functions)", async () => {
    stubTokenFetch({ ok: true });
    subscribeWithFallback({ topic: "mh:inbox" });
    await flush();
    expect(Object.values(realtime)).not.toContain(fakeClient);
  });

  test("socket diagnostics: state + heartbeat fan-out", async () => {
    stubTokenFetch({ ok: true });
    expect(getSocketState()).toBe("uninitialized");
    subscribeWithFallback({ topic: "mh:inspector:x" });
    await flush();
    expect(getSocketState()).toBe("open");

    const seen: realtime.SocketHeartbeat[] = [];
    const off = onSocketHeartbeat((hb) => seen.push(hb));
    const registered = fakeClient.realtime.onHeartbeat.mock.calls[0][0];
    registered("ok", 12);
    expect(seen).toEqual([{ status: "ok", latencyMs: 12 }]);
    off();
    registered("ok", 13);
    expect(seen).toHaveLength(1);
  });
});

describe("subscribeWithFallback", () => {
  test("token unavailable -> onStatus('unavailable'), nothing created, no throw", async () => {
    stubTokenFetch({ ok: false });
    const statuses: string[] = [];
    const sub = subscribeWithFallback({
      topic: "mh:inbox",
      onStatus: (s) => statuses.push(s),
    });
    await flush();

    expect(statuses).toEqual(["connecting", "unavailable"]);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(() => sub.unsubscribe()).not.toThrow();
  });

  test("joins the topic as a PRIVATE channel and goes live on SUBSCRIBED", async () => {
    stubTokenFetch({ ok: true });
    const statuses: string[] = [];
    const events: Array<[string, Record<string, unknown>]> = [];
    subscribeWithFallback({
      topic: "mh:inbox",
      broadcastEvents: ["change"],
      onStatus: (s) => statuses.push(s),
      onEvent: (event, payload) => events.push([event, payload]),
    });
    await flush();

    expect(fakeClient.channel).toHaveBeenCalledWith("mh:inbox", {
      config: { private: true },
    });
    const ch = fakeClient.channels[0];
    ch.subscribeCb?.("SUBSCRIBED");
    expect(statuses).toEqual(["connecting", "live"]);

    const binding = ch.bindings.find(
      (b) => b.type === "broadcast" && b.filter.event === "change",
    );
    binding?.cb({
      type: "broadcast",
      event: "change",
      payload: { table: "sms_inbound_messages", op: "INSERT", id: "42" },
    });
    expect(events).toEqual([
      ["change", { table: "sms_inbound_messages", op: "INSERT", id: "42" }],
    ]);
  });

  test("connect-timeout -> ONE retry after 5s -> 'unavailable' (fake timers)", async () => {
    stubTokenFetch({ ok: true });
    const statuses: string[] = [];
    subscribeWithFallback({
      topic: "mh:inbox",
      onStatus: (s) => statuses.push(s),
    });
    await flush();
    expect(fakeClient.channels).toHaveLength(1); // first attempt, never answers

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); // attempt 1 times out
    expect(fakeClient.removeChannel).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting"]); // still degrading silently

    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS); // the single retry fires
    expect(fakeClient.channels).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS); // retry times out too
    expect(statuses).toEqual(["connecting", "unavailable"]);

    // No further attempts, ever — fallback is terminal.
    await vi.advanceTimersByTimeAsync(10 * CONNECT_TIMEOUT_MS);
    expect(fakeClient.channels).toHaveLength(2);
  });

  test("CHANNEL_ERROR -> retry succeeds -> 'live'", async () => {
    stubTokenFetch({ ok: true });
    const statuses: string[] = [];
    subscribeWithFallback({
      topic: "mh:schedule",
      onStatus: (s) => statuses.push(s),
    });
    await flush();

    fakeClient.channels[0].subscribeCb?.("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(fakeClient.channels).toHaveLength(2);

    fakeClient.channels[1].subscribeCb?.("SUBSCRIBED");
    expect(statuses).toEqual(["connecting", "live"]);
  });

  test("unsubscribe is unmount-safe: cleanup runs once, late callbacks are ignored", async () => {
    stubTokenFetch({ ok: true });
    const statuses: string[] = [];
    const events: unknown[] = [];
    const sub = subscribeWithFallback({
      topic: "mh:inbox",
      broadcastEvents: ["change"],
      onStatus: (s) => statuses.push(s),
      onEvent: (...args) => events.push(args),
    });
    await flush();
    const ch = fakeClient.channels[0];
    ch.subscribeCb?.("SUBSCRIBED");
    expect(statuses).toEqual(["connecting", "live"]);

    sub(); // the handle itself is the unsubscribe function
    sub.unsubscribe(); // idempotent
    expect(fakeClient.removeChannel).toHaveBeenCalledTimes(1);

    // Late socket noise after unmount: no status flips, no events, no timers.
    ch.subscribeCb?.("CLOSED");
    ch.bindings[0]?.cb({ type: "broadcast", event: "change", payload: {} });
    await vi.advanceTimersByTimeAsync(10 * CONNECT_TIMEOUT_MS);
    expect(statuses).toEqual(["connecting", "live"]);
    expect(events).toEqual([]);
    expect(fakeClient.channels).toHaveLength(1);

    // Helpers degrade to "error" after teardown instead of throwing.
    await expect(sub.send("ping", {})).resolves.toBe("error");
  });

  test("send/track/presence helpers proxy to the live channel", async () => {
    stubTokenFetch({ ok: true });
    const presenceStates: unknown[] = [];
    const sub = subscribeWithFallback({
      topic: "mh:inspector:abc",
      presence: { key: "user-1" },
      onPresence: (state) => presenceStates.push(state),
    });
    await flush();
    const ch = fakeClient.channels[0];
    expect(fakeClient.channel).toHaveBeenCalledWith("mh:inspector:abc", {
      config: { private: true, presence: { enabled: true, key: "user-1" } },
    });
    ch.subscribeCb?.("SUBSCRIBED");

    await expect(sub.send("ping", { n: 1 })).resolves.toBe("ok");
    expect(ch.send).toHaveBeenCalledWith({
      type: "broadcast",
      event: "ping",
      payload: { n: 1 },
    });
    await expect(sub.track({ online: true })).resolves.toBe("ok");
    await expect(sub.untrack()).resolves.toBe("ok");

    const sync = ch.bindings.find((b) => b.type === "presence");
    sync?.cb();
    expect(presenceStates).toEqual([{ "user-1": [{ online: true }] }]);
    expect(sub.presenceState()).toEqual({ "user-1": [{ online: true }] });
  });
});

describe("useLiveTopic", () => {
  test("falls back to 'unavailable' when the token endpoint is dark", async () => {
    vi.useRealTimers();
    stubTokenFetch({ ok: false });
    const { result, unmount } = renderHook(() => useLiveTopic("mh:inbox"));
    expect(result.current).toBe("connecting");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current).toBe("unavailable");
    unmount();
  });

  test("multi-topic: live when ANY topic subscribes; unmount tears all down", async () => {
    vi.useRealTimers();
    stubTokenFetch({ ok: true });
    const { result, unmount } = renderHook(() =>
      useLiveTopic(["mh:campaign:c1", "mh:inbox"]),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fakeClient.channels.map((c) => c.topic)).toEqual([
      "mh:campaign:c1",
      "mh:inbox",
    ]);

    await act(async () => {
      fakeClient.channels[0].subscribeCb?.("SUBSCRIBED");
    });
    expect(result.current).toBe("live");

    unmount();
    expect(fakeClient.removeChannel).toHaveBeenCalledTimes(2);
    // Post-unmount socket noise must not warn or set state (unmount-safe).
    fakeClient.channels[1].subscribeCb?.("SUBSCRIBED");
  });

  test("no topic -> 'unavailable' without touching the network", async () => {
    vi.useRealTimers();
    const fetchMock = stubTokenFetch({ ok: true });
    const { result, unmount } = renderHook(() => useLiveTopic(null));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });
});
