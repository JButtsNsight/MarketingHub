"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../ui/Badge";
import { CodeBlock } from "../ui/CodeBlock";
import { DataGrid, type GridColumn, type GridSort } from "../ui/DataGrid";
import { Section } from "../ui/Section";
import { StatusPill, type StatusKind } from "../ui/StatusPill";
import { Surface } from "../Surface";
import { useConfirm } from "../ui/AlertDialog";
import {
  DEFAULT_BROADCAST_EVENTS,
  fetchRealtimeToken,
  getSocketState,
  onSocketHeartbeat,
  subscribeWithFallback,
  type LiveStatus,
  type LiveSubscription,
  type PresenceStateMap,
  type SocketHeartbeat,
} from "@/lib/realtime/client";

/**
 * Realtime Inspector (Studio → Realtime parity): a diagnostic console over the
 * Wave-5 foundation wrapper. Join a channel by topic, watch a timestamped feed
 * of broadcast / presence / lifecycle events, publish test broadcasts, and
 * track/list presence — all through `subscribeWithFallback`, never a raw
 * Supabase client.
 *
 * Graceful degradation is the whole point: until an operator applies the W5
 * migration + the /realtime/v1/* ALB rule + the token-route env, the token
 * endpoint answers 503 and this console renders the honest
 * "Realtime unreachable" state instead of pretending. Nothing else in the app
 * changes either way.
 *
 * Auth/refresh is entirely the foundation's job: the socket carries the anon
 * apikey, channel joins carry a short-lived per-user JWT, and realtime-js
 * re-runs the token callback on every 25s heartbeat, so 300s JWTs never lapse.
 *
 * Sending is a real write to every subscriber, so the FIRST send of a browser
 * session goes through the interrupting confirm modal (console precedent:
 * guards sit on writes, never on browsing); later sends in the same session
 * pass straight through.
 */

/** sessionStorage flag: the user already confirmed sending this session. */
const SEND_CONFIRM_KEY = "mh:realtime-inspector:send-confirmed";

function sessionSendConfirmed(): boolean {
  try {
    return window.sessionStorage.getItem(SEND_CONFIRM_KEY) === "1";
  } catch {
    return false; // storage blocked — fall back to confirming every time
  }
}

function rememberSendConfirmed(): void {
  try {
    window.sessionStorage.setItem(SEND_CONFIRM_KEY, "1");
  } catch {
    // storage blocked — the confirm will simply re-ask next send
  }
}

type FeedKind = "broadcast" | "presence" | "status" | "sent";

interface FeedEntry {
  seq: number;
  at: string;
  kind: FeedKind;
  event: string;
  payload: Record<string, unknown>;
}

/** Keep the feed bounded — an inspector, not a log store. */
const FEED_MAX = 200;

/** Wall-clock stamp with millis, e.g. "14:03:22.418". */
function stamp(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

const FEED_COLUMNS: GridColumn[] = (
  [
    ["at", "text"],
    ["kind", "text"],
    ["event", "text"],
    ["payload", "jsonb"],
  ] as const
).map(([name, format]) => ({
  name,
  format,
  isPrimaryKey: false,
  isNullable: false,
  isEditable: false,
  enums: [],
}));

function statusChip(status: LiveStatus | null): {
  kind: StatusKind;
  label: string;
} {
  switch (status) {
    case "live":
      return { kind: "ok", label: "live" };
    case "connecting":
      return { kind: "run", label: "connecting" };
    case "unavailable":
      return { kind: "warn", label: "unavailable" };
    default:
      return { kind: "idle", label: "not joined" };
  }
}

export function RealtimeInspector({ userEmail }: { userEmail: string }) {
  // ---- connection diagnostics -------------------------------------------
  const [tokenState, setTokenState] = useState<"checking" | "ok" | "unreachable">(
    "checking",
  );
  const [socketState, setSocketState] = useState<string>(getSocketState());
  const [heartbeat, setHeartbeat] = useState<SocketHeartbeat | null>(null);

  // ---- channel / join form ----------------------------------------------
  const [topicInput, setTopicInput] = useState(
    () => `mh:inspector:${Math.random().toString(36).slice(2, 8)}`,
  );
  const [eventsInput, setEventsInput] = useState(
    DEFAULT_BROADCAST_EVENTS.join(", "),
  );
  const [joinedTopic, setJoinedTopic] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const subRef = useRef<LiveSubscription | null>(null);

  // ---- broadcast send form ----------------------------------------------
  const [sendEvent, setSendEvent] = useState("change");
  const [sendPayloadText, setSendPayloadText] = useState(
    '{\n  "hello": "inspector"\n}',
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // ---- presence -----------------------------------------------------------
  const [presence, setPresence] = useState<PresenceStateMap>({});
  const [tracked, setTracked] = useState(false);

  // ---- message feed -------------------------------------------------------
  const [log, setLog] = useState<FeedEntry[]>([]);
  const [sort, setSort] = useState<GridSort | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const seqRef = useRef(0);

  const pushEntry = (
    kind: FeedKind,
    event: string,
    payload: Record<string, unknown>,
  ) => {
    seqRef.current += 1;
    const entry: FeedEntry = {
      seq: seqRef.current,
      at: stamp(),
      kind,
      event,
      payload,
    };
    setLog((prev) => [entry, ...prev].slice(0, FEED_MAX));
  };

  // Preflight the token endpoint (honest banner without needing a join) and
  // fan heartbeats into the connection panel. Both foundation calls are safe
  // pre-socket; the heartbeat remover is the effect cleanup.
  useEffect(() => {
    let cancelled = false;
    void fetchRealtimeToken().then((info) => {
      if (!cancelled) setTokenState(info ? "ok" : "unreachable");
    });
    const off = onSocketHeartbeat((hb) => {
      setHeartbeat(hb);
      setSocketState(getSocketState());
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Unmount teardown: the wrapper guarantees no callback fires afterwards.
  useEffect(
    () => () => {
      subRef.current?.unsubscribe();
    },
    [],
  );

  const leave = () => {
    const sub = subRef.current;
    if (!sub) return;
    subRef.current = null;
    sub.unsubscribe();
    setJoinedTopic(null);
    setStatus(null);
    setPresence({});
    setTracked(false);
    setSocketState(getSocketState());
  };

  const join = () => {
    setJoinError(null);
    const topic = topicInput.trim();
    if (!topic) {
      setJoinError("Enter a topic to join.");
      return;
    }
    leave();
    const events = eventsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sub = subscribeWithFallback({
      topic,
      ...(events.length > 0 ? { broadcastEvents: events } : {}),
      presence: { key: userEmail },
      onStatus: (s) => {
        setStatus(s);
        setSocketState(getSocketState());
        pushEntry("status", s, { topic });
      },
      onEvent: (event, payload) => {
        pushEntry("broadcast", event, payload);
      },
      onPresence: (state) => {
        setPresence(state);
        pushEntry("presence", "sync", { keys: Object.keys(state).length });
      },
    });
    subRef.current = sub;
    setJoinedTopic(topic);
    setStatus("connecting");
  };

  const doSend = async () => {
    setSendError(null);
    const sub = subRef.current;
    const topic = joinedTopic;
    if (!sub || !topic) {
      setSendError("Join a channel first.");
      return;
    }
    const event = sendEvent.trim();
    if (!event) {
      setSendError("Enter an event name.");
      return;
    }
    let payload: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(sendPayloadText);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("not an object");
      }
      payload = raw as Record<string, unknown>;
    } catch {
      setSendError("Payload must be a JSON object.");
      return;
    }
    // Sending reaches every subscriber on the topic — the write gets the
    // interrupting confirm, once per browser session (console precedent).
    if (!sessionSendConfirmed()) {
      const ok = await confirm({
        title: "Send a live broadcast?",
        message: (
          <>
            This publishes <span className="mono">{event}</span> to every
            subscriber on <span className="mono">{topic}</span> through the
            realtime socket. You&apos;ll only be asked once per session.
          </>
        ),
        confirmLabel: "Send broadcast",
      });
      if (!ok) return;
      rememberSendConfirmed();
    }
    const result = await sub.send(event, payload);
    pushEntry("sent", event, payload);
    setSocketState(getSocketState());
    if (result !== "ok") {
      setSendError(
        `Send resolved "${result}" — the channel is not live (realtime unavailable or still connecting).`,
      );
    }
  };

  const doTrack = async () => {
    const sub = subRef.current;
    if (!sub) return;
    const meta = { email: userEmail, online_at: new Date().toISOString() };
    const result = await sub.track(meta);
    setTracked(result === "ok");
    pushEntry("presence", result === "ok" ? "track" : `track (${result})`, meta);
    setPresence(sub.presenceState());
  };

  const doUntrack = async () => {
    const sub = subRef.current;
    if (!sub) return;
    const result = await sub.untrack();
    setTracked(false);
    pushEntry("presence", result === "ok" ? "untrack" : `untrack (${result})`, {
      email: userEmail,
    });
    setPresence(sub.presenceState());
  };

  const rows = useMemo(() => {
    const base: Array<Record<string, unknown>> = log.map((e) => ({
      seq: e.seq,
      at: e.at,
      kind: e.kind,
      event: e.event,
      payload: e.payload,
    }));
    if (!sort) return base;
    const dir = sort.ascending ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = String(a[sort.column] ?? "");
      const bv = String(b[sort.column] ?? "");
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [log, sort]);

  const viewerEntry =
    log.find((e) => selectedKeys.has(String(e.seq))) ?? log[0] ?? null;
  const viewerCode = viewerEntry
    ? JSON.stringify(
        {
          at: viewerEntry.at,
          kind: viewerEntry.kind,
          event: viewerEntry.event,
          payload: viewerEntry.payload,
        },
        null,
        2,
      )
    : "// No messages yet — join a channel, then send a broadcast\n// or change a campaign/inbox row to fire the W5 DB triggers.";

  const chip = statusChip(status);
  const unreachable = tokenState === "unreachable" || status === "unavailable";
  const topicIsMh = topicInput.trim().startsWith("mh:");

  return (
    <div className="stack">
      {unreachable ? (
        <Surface className="empty-state" elevated={false} role="alert">
          <p>
            <strong>Realtime unreachable — ALB route/env not applied yet.</strong>
          </p>
        </Surface>
      ) : null}

      <Section eyebrow="Socket" title="Connection">
        <div className="campaign-actions">
          <span data-testid="rt-connection-status">
            <StatusPill status={chip.kind}>{chip.label}</StatusPill>
          </span>
          <Badge>socket: {socketState}</Badge>
          <Badge>
            token:{" "}
            {tokenState === "checking"
              ? "checking…"
              : tokenState === "ok"
                ? "ok"
                : "unreachable"}
          </Badge>
          <Badge>
            heartbeat:{" "}
            {heartbeat
              ? `${heartbeat.status}${
                  heartbeat.latencyMs != null
                    ? ` · ${Math.round(heartbeat.latencyMs)}ms`
                    : ""
                }`
              : "—"}
          </Badge>
          {joinedTopic ? <Badge tone="var(--data-2)">{joinedTopic}</Badge> : null}
        </div>
      </Section>

      <Section
        eyebrow="Channel"
        title="Join a channel"
        actions={
          joinedTopic ? (
            <button type="button" className="type-chip" onClick={leave}>
              Leave
            </button>
          ) : null
        }
      >
        <div className="field">
          <label htmlFor="rt-topic">topic</label>
          <input
            id="rt-topic"
            className="surface control mono"
            type="text"
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rt-events">listen events (comma-separated)</label>
          <input
            id="rt-events"
            className="surface control mono"
            type="text"
            value={eventsInput}
            onChange={(e) => setEventsInput(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="teditor-null">
            <input type="checkbox" checked readOnly disabled /> private (locked
            on)
          </label>
        </div>
        {!topicIsMh ? (
          <p className="teditor-test">
            This topic is outside <span className="mono">mh:*</span> — the
            private-channel policies will refuse the join.
          </p>
        ) : null}
        {joinError ? (
          <p className="form-error" role="alert">
            {joinError}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn-primary" onClick={join}>
            Join
          </button>
        </div>
      </Section>

      <Section eyebrow="Broadcast" title="Send test broadcast">
        <div className="field">
          <label htmlFor="rt-send-event">event</label>
          <input
            id="rt-send-event"
            className="surface control mono"
            type="text"
            value={sendEvent}
            onChange={(e) => setSendEvent(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rt-send-payload">payload (JSON object)</label>
          <textarea
            id="rt-send-payload"
            className="surface control mono"
            rows={4}
            value={sendPayloadText}
            onChange={(e) => setSendPayloadText(e.target.value)}
          />
        </div>
        {sendError ? (
          <p className="form-error" role="alert">
            {sendError}
          </p>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={joinedTopic === null}
            title={joinedTopic === null ? "Join a channel first." : undefined}
            onClick={() => void doSend()}
          >
            Send
          </button>
        </div>
      </Section>

      <Section
        eyebrow="Presence"
        title="Who's here"
        actions={
          <>
            <button
              type="button"
              className="type-chip"
              disabled={joinedTopic === null || tracked}
              onClick={() => void doTrack()}
            >
              Track
            </button>
            <button
              type="button"
              className="type-chip"
              disabled={joinedTopic === null || !tracked}
              onClick={() => void doUntrack()}
            >
              Untrack
            </button>
          </>
        }
      >
        {Object.keys(presence).length === 0 ? (
          <p className="panel-desc">
            No presence entries — join a channel and Track to appear here.
          </p>
        ) : (
          <ul className="stack">
            {Object.entries(presence).map(([key, metas]) => (
              <li key={key}>
                <Badge tone="var(--data-2)">{key}</Badge>{" "}
                <span className="mono">{JSON.stringify(metas)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        eyebrow="Feed"
        title="Messages"
        description="Newest first, capped at 200 — select a row to inspect its payload."
        actions={
          <button
            type="button"
            className="type-chip"
            disabled={log.length === 0}
            onClick={() => {
              setLog([]);
              setSelectedKeys(new Set());
            }}
          >
            Clear
          </button>
        }
      >
        <div className="stack">
          <DataGrid
            columns={FEED_COLUMNS}
            rows={rows}
            getRowKey={(row) => String(row.seq)}
            sort={sort}
            onSortChange={setSort}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            empty="No messages yet."
          />
          <CodeBlock label="payload" code={viewerCode} />
        </div>
      </Section>

      {dialog}
    </div>
  );
}

export default RealtimeInspector;
