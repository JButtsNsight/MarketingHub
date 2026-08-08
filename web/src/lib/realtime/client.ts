"use client";

import { useEffect, useRef, useState } from "react";

import {
  createClient,
  type RealtimeChannel,
  type RealtimeChannelSendResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";

/**
 * Wave-5 FOUNDATION — browser-side Realtime access, same-origin only.
 *
 * The browser can ONLY reach the Next.js app through the app ALB; a listener
 * rule for `/realtime/v1/*` (staged app-infra change) forwards WebSocket
 * traffic to the self-hosted Supabase Kong. supabase-js derives its realtime
 * URL purely from the createClient base URL, so pointing a client at
 * `window.location.origin` yields
 * `wss://<app-host>/realtime/v1/websocket?apikey=<anon>&vsn=2.0.0`.
 *
 * The raw Supabase client is NEVER exported: its auth/rest/storage URLs also
 * derive from the app origin and would 404 — only realtime is routed. Consumers
 * use the exports below, all of which degrade gracefully: until the human
 * applies the W5 migration + ALB rule + env, every surface sees `unavailable`
 * and renders today's static behavior unchanged.
 *
 * Auth model: the connect URL carries the ANON key as `apikey` (Kong key-auth)
 * and every channel join carries a short-lived per-user JWT from
 * GET /api/realtime/token. realtime-js re-runs the `accessToken` callback on
 * every 25s heartbeat, so 300s tokens stay perpetually fresh with no timers.
 */

/** Response shape of GET /api/realtime/token (also validated client-side). */
export type RealtimeTokenInfo = {
  /** Short-lived (<=300s) HS256 user JWT — the realtime channel-join token. */
  token: string;
  /** Epoch ms when `token` expires (client refreshes 60s early). */
  expiresAtMs: number;
  /** The stack ANON key — the `apikey` query param on the socket URL. */
  anonKey: string;
};

/** Wrapper lifecycle status. `unavailable` == render today's static behavior. */
export type LiveStatus = "connecting" | "live" | "unavailable";

/** Presence state: presence key -> tracked metadata entries. */
export type PresenceStateMap = Record<string, Array<Record<string, unknown>>>;

/** One socket heartbeat observation (Inspector connection panel). */
export type SocketHeartbeat = {
  status: "sent" | "ok" | "error" | "timeout" | "disconnected" | (string & {});
  latencyMs?: number;
};

export type SubscribeWithFallbackOptions = {
  /** Channel topic. Policy-gated: only `mh:*` private topics are joinable. */
  topic: string;
  /** Broadcast event names to deliver to `onEvent`. Default: `["change"]`. */
  broadcastEvents?: readonly string[];
  /** Receives `(event, payload)` for each subscribed broadcast event. */
  onEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** Lifecycle callback; fires `connecting` -> `live` | `unavailable`. */
  onStatus?: (status: LiveStatus) => void;
  /** Enable presence on the channel (`true` or `{ key }`). */
  presence?: boolean | { key?: string };
  /** Presence sync callback (only fires when `presence` is enabled). */
  onPresence?: (state: PresenceStateMap) => void;
};

/**
 * Handle returned by {@link subscribeWithFallback}. Callable — `handle()` is
 * `handle.unsubscribe()` — so `useEffect(() => subscribeWithFallback(...))`
 * cleanup works directly. The send/track helpers await channel readiness and
 * resolve `"error"` (never throw) when realtime is unavailable.
 */
export type LiveSubscription = {
  (): void;
  unsubscribe: () => void;
  send: (
    event: string,
    payload: Record<string, unknown>,
  ) => Promise<RealtimeChannelSendResponse>;
  track: (
    payload: Record<string, unknown>,
  ) => Promise<RealtimeChannelSendResponse>;
  untrack: () => Promise<RealtimeChannelSendResponse>;
  presenceState: () => PresenceStateMap;
};

export type UseLiveTopicOptions = {
  broadcastEvents?: readonly string[];
  onEvent?: (
    event: string,
    payload: Record<string, unknown>,
    topic: string,
  ) => void;
  presence?: boolean | { key?: string };
  onPresence?: (state: PresenceStateMap, topic: string) => void;
};

/** DB broadcast triggers (W5 migration) send everything as event `change`. */
export const DEFAULT_BROADCAST_EVENTS: readonly string[] = ["change"];

const TOKEN_ENDPOINT = "/api/realtime/token";

/** Refresh the cached token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Give a channel join this long before treating the attempt as failed. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Wait this long before the single retry after a failed/killed channel. */
export const RETRY_DELAY_MS = 5_000;

/** 25s heartbeat < the ALB 60s idle timeout; also re-runs `accessToken`. */
const HEARTBEAT_INTERVAL_MS = 25_000;

let cachedToken: RealtimeTokenInfo | null = null;
let cachedClient: SupabaseClient | null = null;
const heartbeatListeners = new Set<(hb: SocketHeartbeat) => void>();

function looksLikeTokenInfo(value: unknown): value is RealtimeTokenInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === "string" &&
    v.token.length > 0 &&
    typeof v.expiresAtMs === "number" &&
    Number.isFinite(v.expiresAtMs) &&
    typeof v.anonKey === "string" &&
    v.anonKey.length > 0
  );
}

/**
 * Fetch (with a small cache) the realtime credentials for the CURRENT session.
 * Returns null on ANY failure — non-2xx (503 when the W5 env is not applied,
 * 401/403 outside a session), network error, malformed body — never throws.
 * The cache is per-tab and reused only until `expiresAtMs - 60s`.
 */
export async function fetchRealtimeToken(): Promise<RealtimeTokenInfo | null> {
  if (typeof window === "undefined") return null; // browser-only module
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken;
  }
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!looksLikeTokenInfo(body)) return null;
    cachedToken = {
      token: body.token,
      expiresAtMs: body.expiresAtMs,
      anonKey: body.anonKey,
    };
    return cachedToken;
  } catch {
    return null;
  }
}

/**
 * Lazily create the module-singleton Supabase client pointed at the app
 * origin. Internal on purpose — the wrapper below is the only consumer.
 * Returns null (no throw) when the token endpoint is unavailable.
 */
async function getRealtimeClient(): Promise<SupabaseClient | null> {
  if (typeof window === "undefined") return null;
  if (cachedClient) return cachedClient;
  const info = await fetchRealtimeToken();
  if (!info) return null;
  if (cachedClient) return cachedClient; // lost a concurrent race — reuse
  const created = createClient(window.location.origin, info.anonKey, {
    // Re-runs on every heartbeat; keeps 300s user JWTs perpetually fresh.
    accessToken: async () => (await fetchRealtimeToken())?.token ?? null,
    realtime: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS },
  });
  created.realtime.onHeartbeat((status, latency) => {
    for (const listener of [...heartbeatListeners]) {
      try {
        listener({ status, latencyMs: latency });
      } catch {
        // A listener error must never break the socket loop.
      }
    }
  });
  cachedClient = created;
  return cachedClient;
}

/**
 * Current realtime socket state for diagnostics (Inspector connection panel).
 * `uninitialized` = no subscription has ever produced a client in this tab.
 */
export function getSocketState():
  | "uninitialized"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | (string & {}) {
  if (!cachedClient) return "uninitialized";
  try {
    return cachedClient.realtime.connectionState();
  } catch {
    return "uninitialized";
  }
}

/**
 * Observe socket heartbeats (`sent`/`ok`/`error`/`timeout`/`disconnected` +
 * latency). Returns a removal function. Safe to call before any client exists.
 */
export function onSocketHeartbeat(
  listener: (hb: SocketHeartbeat) => void,
): () => void {
  heartbeatListeners.add(listener);
  return () => {
    heartbeatListeners.delete(listener);
  };
}

/**
 * Graceful-degradation subscribe. Joins `topic` as a PRIVATE channel (RLS
 * policies on realtime.messages gate mh:* topics) and reports status:
 *
 * - token endpoint unavailable  -> `unavailable` (no throw, nothing created)
 * - SUBSCRIBED                  -> `live`
 * - error/timeout/close         -> ONE retry after 5s, then `unavailable`
 *
 * On `unavailable` consumers keep today's behavior unchanged (static render +
 * mutation-driven router.refresh()). Cleanup is idempotent and unmount-safe:
 * after unsubscribe no callback ever fires again.
 */
export function subscribeWithFallback(
  options: SubscribeWithFallbackOptions,
): LiveSubscription {
  const {
    topic,
    broadcastEvents = DEFAULT_BROADCAST_EVENTS,
    onEvent,
    onStatus,
    presence,
    onPresence,
  } = options;

  let stopped = false;
  let retried = false;
  let status: LiveStatus | null = null;
  let client: SupabaseClient | null = null;
  let channel: RealtimeChannel | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: LiveStatus): void => {
    if (stopped || status === next) return;
    status = next;
    try {
      onStatus?.(next);
    } catch {
      // Consumer callback errors never break the subscription machinery.
    }
  };

  const clearTimers = (): void => {
    if (connectTimer !== null) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const teardownChannel = (): void => {
    if (!channel) return;
    const ch = channel;
    channel = null; // null FIRST so this channel's late callbacks are ignored
    try {
      void client?.removeChannel(ch).catch(() => {});
    } catch {
      // Best-effort cleanup only.
    }
  };

  const fail = (): void => {
    if (stopped) return;
    clearTimers();
    teardownChannel();
    if (!retried) {
      retried = true;
      setStatus("connecting");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!stopped) attach();
      }, RETRY_DELAY_MS);
    } else {
      setStatus("unavailable");
    }
  };

  const attach = (): void => {
    if (stopped || !client) return;
    const ch = client.channel(topic, {
      config: {
        private: true, // mh:* topics are RLS-gated; public join is refused
        ...(presence
          ? {
              presence: {
                enabled: true,
                ...(typeof presence === "object" && presence.key
                  ? { key: presence.key }
                  : {}),
              },
            }
          : {}),
      },
    });
    for (const event of broadcastEvents) {
      ch.on("broadcast", { event }, (message) => {
        if (stopped || channel !== ch) return;
        const payload = (message as { payload?: unknown }).payload;
        try {
          onEvent?.(
            event,
            (payload && typeof payload === "object"
              ? payload
              : {}) as Record<string, unknown>,
          );
        } catch {
          // Consumer callback errors never break the channel.
        }
      });
    }
    if (presence) {
      ch.on("presence", { event: "sync" }, () => {
        if (stopped || channel !== ch) return;
        try {
          onPresence?.(ch.presenceState() as unknown as PresenceStateMap);
        } catch {
          // Consumer callback errors never break the channel.
        }
      });
    }
    channel = ch;
    connectTimer = setTimeout(() => {
      connectTimer = null;
      fail();
    }, CONNECT_TIMEOUT_MS);
    ch.subscribe((subscribeStatus) => {
      if (stopped || channel !== ch) return;
      const s: string = subscribeStatus;
      if (s === "SUBSCRIBED") {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        setStatus("live");
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
        fail();
      }
    });
  };

  setStatus("connecting");

  const ready: Promise<void> = (async () => {
    const resolved = await getRealtimeClient();
    if (stopped) return;
    if (!resolved) {
      // Token endpoint says no (flag off / no ALB route / no session):
      // honest fallback, nothing to clean up, no throw.
      setStatus("unavailable");
      return;
    }
    client = resolved;
    attach();
  })().catch(() => {
    setStatus("unavailable");
  });

  const unsubscribe = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    teardownChannel();
  };

  const withChannel = async (
    run: (ch: RealtimeChannel) => Promise<RealtimeChannelSendResponse>,
  ): Promise<RealtimeChannelSendResponse> => {
    await ready;
    if (stopped || !channel) return "error";
    try {
      return await run(channel);
    } catch {
      return "error";
    }
  };

  return Object.assign(
    () => {
      unsubscribe();
    },
    {
      unsubscribe,
      send: (event: string, payload: Record<string, unknown>) =>
        withChannel((ch) => ch.send({ type: "broadcast", event, payload })),
      track: (payload: Record<string, unknown>) =>
        withChannel((ch) => ch.track(payload)),
      untrack: () => withChannel((ch) => ch.untrack()),
      presenceState: (): PresenceStateMap =>
        channel && !stopped
          ? (channel.presenceState() as unknown as PresenceStateMap)
          : {},
    },
  );
}

/**
 * React hook over {@link subscribeWithFallback}. Accepts one topic or several
 * (combined status: `live` if ANY topic is live, `unavailable` only when ALL
 * are). Callback identity changes never resubscribe (latest-ref pattern);
 * unmount tears every subscription down and nothing sets state afterwards.
 */
export function useLiveTopic(
  topic: string | readonly string[] | null | undefined,
  options: UseLiveTopicOptions = {},
): LiveStatus {
  const topics: string[] = (
    typeof topic === "string" ? [topic] : (topic ?? [])
  ).filter((t): t is string => Boolean(t));
  // JSON keys: effect deps stay primitive, and any topic/event chars survive.
  const topicsKey = JSON.stringify(topics);
  const eventsKey = JSON.stringify(
    options.broadcastEvents ?? DEFAULT_BROADCAST_EVENTS,
  );
  const presenceKey = options.presence
    ? JSON.stringify(options.presence)
    : "";

  const [status, setStatus] = useState<LiveStatus>(
    topics.length > 0 ? "connecting" : "unavailable",
  );

  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (topicsKey === "[]") {
      setStatus("unavailable");
      return;
    }
    const effectTopics = JSON.parse(topicsKey) as string[];
    const effectEvents = JSON.parse(eventsKey) as string[];
    let cancelled = false;

    const perTopic = new Map<string, LiveStatus>(
      effectTopics.map((t) => [t, "connecting" as LiveStatus]),
    );
    const recompute = (): void => {
      if (cancelled) return;
      const all = [...perTopic.values()];
      setStatus(
        all.includes("live")
          ? "live"
          : all.every((s) => s === "unavailable")
            ? "unavailable"
            : "connecting",
      );
    };

    setStatus("connecting");
    const subscriptions = effectTopics.map((t) =>
      subscribeWithFallback({
        topic: t,
        broadcastEvents: effectEvents,
        presence: latest.current.presence,
        onStatus: (s) => {
          perTopic.set(t, s);
          recompute();
        },
        onEvent: (event, payload) => {
          if (!cancelled) latest.current.onEvent?.(event, payload, t);
        },
        onPresence: (state) => {
          if (!cancelled) latest.current.onPresence?.(state, t);
        },
      }),
    );

    return () => {
      cancelled = true;
      for (const subscription of subscriptions) subscription.unsubscribe();
    };
  }, [topicsKey, eventsKey, presenceKey]);

  return status;
}

/**
 * TEST-ONLY: drop the module singletons (token cache, client, heartbeat
 * listeners) so each test starts cold. Never call from app code.
 */
export function __resetRealtimeForTests(): void {
  cachedToken = null;
  if (cachedClient) {
    try {
      void cachedClient.realtime?.disconnect?.();
    } catch {
      // Best-effort.
    }
  }
  cachedClient = null;
  heartbeatListeners.clear();
}
