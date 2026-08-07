"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { useConfirm } from "../ui/AlertDialog";
import { Surface } from "../Surface";

/**
 * pgmq Queues — the interactive half of Studio's Queues integration. The queue
 * overview (from pgmq.list_queues + pgmq.metrics) is browsed freely; selecting
 * a queue opens live (peek) and archived message views. Peeking reads the
 * backing table directly, so it NEVER consumes a message or resets a
 * visibility timeout. Every message-removing action (archive / delete / pop)
 * and is interrupted by the confirm modal — the guard sits on the write, not on
 * browsing. Sending a test message is additive, so it lives behind an explicit
 * panel rather than a modal.
 */

export interface QueueOverviewRow {
  name: string;
  isPartitioned: boolean;
  isUnlogged: boolean;
  createdAt: string | null;
  queueLength: number;
  totalMessages: number;
  newestMsgAgeSec: number | null;
  oldestMsgAgeSec: number | null;
  scrapeTime: string | null;
  archiveCount: number | null;
}

interface QueueMessage {
  msgId: number;
  readCount: number;
  enqueuedAt: string | null;
  vt: string | null;
  message: unknown;
}

const MESSAGE_LIMIT = 100;

function ageLabel(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function bodyPreview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text ?? "";
}

function BodyCell({ value }: { value: unknown }) {
  const text = bodyPreview(value);
  return (
    <span title={text}>{text.length > 80 ? `${text.slice(0, 79)}…` : text}</span>
  );
}

export function QueuesClient({
  initialQueues,
}: {
  initialQueues: QueueOverviewRow[];
}) {
  const [queues, setQueues] = useState(initialQueues);
  const [selected, setSelected] = useState<string | null>(
    initialQueues[0]?.name ?? null,
  );
  const [live, setLive] = useState<QueueMessage[]>([]);
  const [archived, setArchived] = useState<QueueMessage[]>([]);
  const [archiveCount, setArchiveCount] = useState<number | null>(null);
  const [msgLoading, setMsgLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendText, setSendText] = useState('{\n  "hello": "world"\n}');
  const [sendBusy, setSendBusy] = useState(false);

  const { confirm, dialog } = useConfirm();

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch("/api/console/queues");
      if (!res.ok) return;
      const body = (await res.json()) as { queues?: QueueOverviewRow[] };
      if (Array.isArray(body.queues)) setQueues(body.queues);
    } catch {
      // overview refresh is best-effort; the message views own the error surface
    }
  }, []);

  const loadMessages = useCallback(async (queue: string) => {
    setMsgLoading(true);
    setError(null);
    try {
      const [liveRes, archRes] = await Promise.all([
        fetch(
          `/api/console/queues?queue=${encodeURIComponent(queue)}&mode=live&limit=${MESSAGE_LIMIT}`,
        ),
        fetch(
          `/api/console/queues?queue=${encodeURIComponent(queue)}&mode=archived&limit=${MESSAGE_LIMIT}`,
        ),
      ]);
      const liveBody = (await liveRes.json().catch(() => null)) as
        | { messages?: QueueMessage[]; error?: string }
        | null;
      const archBody = (await archRes.json().catch(() => null)) as
        | { messages?: QueueMessage[]; count?: number; error?: string }
        | null;
      if (!liveRes.ok) {
        setError(liveBody?.error ?? "Loading messages failed.");
        setLive([]);
        setArchived([]);
        setArchiveCount(null);
        return;
      }
      setLive(liveBody?.messages ?? []);
      setArchived(archBody?.messages ?? []);
      setArchiveCount(archBody?.count ?? null);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setMsgLoading(false);
    }
  }, []);

  // Hydrate accurate archive counts (the SSR pass ships them as null) and, when
  // a queue is selected, its message views.
  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (selected) void loadMessages(selected);
  }, [selected, loadMessages]);

  const refresh = useCallback(async () => {
    await Promise.all([loadOverview(), selected ? loadMessages(selected) : Promise.resolve()]);
  }, [loadOverview, loadMessages, selected]);

  const selectedRow = useMemo(
    () => queues.find((q) => q.name === selected) ?? null,
    [queues, selected],
  );

  const totals = useMemo(
    () => ({
      queues: queues.length,
      pending: queues.reduce((sum, q) => sum + q.queueLength, 0),
      archived: queues.reduce(
        (sum, q) => sum + (q.archiveCount ?? 0),
        0,
      ),
    }),
    [queues],
  );

  const mutate = useCallback(
    async (init: RequestInit): Promise<boolean> => {
      setError(null);
      try {
        const res = await fetch("/api/console/queues", init);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(body?.error ?? "The action failed.");
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError("Network error — please try again.");
        return false;
      }
    },
    [refresh],
  );

  const onArchive = async (msgId: number) => {
    if (!selected) return;
    const ok = await confirm({
      title: "Archive this message?",
      message: `Move message ${msgId} out of "${selected}" into its archive table (pgmq.a_${selected}). It leaves the live queue.`,
      confirmLabel: "Archive",
    });
    if (!ok) return;
    await mutate({
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: selected, msgId }),
    });
  };

  const onDelete = async (msgId: number) => {
    if (!selected) return;
    const ok = await confirm({
      title: "Delete this message?",
      message: `Permanently delete message ${msgId} from "${selected}". This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await mutate({
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: selected, msgId }),
    });
  };

  const onPop = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: "Pop the next message?",
      message: `Read AND remove the next visible message from "${selected}". Popped messages are consumed — this cannot be undone.`,
      confirmLabel: "Pop",
    });
    if (!ok) return;
    await mutate({
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: selected, pop: true }),
    });
  };

  const submitSend = async () => {
    if (!selected) return;
    let message: unknown;
    try {
      message = JSON.parse(sendText);
    } catch {
      setError("Message must be valid JSON.");
      return;
    }
    setSendBusy(true);
    const ok = await mutate({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queue: selected, message }),
    });
    setSendBusy(false);
    if (ok) setSendOpen(false);
  };

  const overviewColumns: Column<QueueOverviewRow>[] = [
    { key: "name", header: "queue", mono: true },
    {
      key: "queueLength",
      header: "pending",
      mono: true,
      align: "right",
      width: "100px",
      render: (q) => q.queueLength.toLocaleString(),
    },
    {
      key: "totalMessages",
      header: "total",
      mono: true,
      align: "right",
      width: "100px",
      render: (q) => q.totalMessages.toLocaleString(),
    },
    {
      key: "archiveCount",
      header: "archived",
      mono: true,
      align: "right",
      width: "100px",
      render: (q) =>
        q.archiveCount == null ? "—" : q.archiveCount.toLocaleString(),
    },
    {
      key: "oldestMsgAgeSec",
      header: "oldest",
      mono: true,
      align: "right",
      width: "90px",
      render: (q) => ageLabel(q.oldestMsgAgeSec),
    },
    {
      key: "flags",
      header: "flags",
      width: "160px",
      render: (q) => (
        <>
          {q.isUnlogged ? <Badge tone="var(--warn)">unlogged</Badge> : null}
          {q.isPartitioned ? <Badge tone="var(--data-2)">partitioned</Badge> : null}
          {!q.isUnlogged && !q.isPartitioned ? (
            <span className="teditor-test mono">—</span>
          ) : null}
        </>
      ),
    },
    {
      key: "select",
      header: "",
      width: "120px",
      render: (q) => (
        <button
          type="button"
          className={selected === q.name ? "type-chip on" : "type-chip"}
          onClick={() => setSelected(q.name)}
        >
          Messages
        </button>
      ),
    },
  ];

  const liveColumns: Column<QueueMessage>[] = [
    { key: "msgId", header: "msg_id", mono: true, width: "90px" },
    { key: "readCount", header: "reads", mono: true, align: "right", width: "70px" },
    { key: "enqueuedAt", header: "enqueued", mono: true, width: "200px" },
    { key: "vt", header: "vt", mono: true, width: "200px" },
    {
      key: "message",
      header: "message",
      mono: true,
      render: (m) => <BodyCell value={m.message} />,
    },
    {
      key: "actions",
      header: "",
      width: "160px",
      render: (m) => (
        <div className="dgrid-toolbar" style={{ padding: 0, margin: 0 }}>
          <button
            type="button"
            className="type-chip"
            onClick={() => onArchive(m.msgId)}
          >
            Archive
          </button>
          <button
            type="button"
            className="type-chip"
            onClick={() => onDelete(m.msgId)}
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  const archivedColumns: Column<QueueMessage>[] = [
    { key: "msgId", header: "msg_id", mono: true, width: "90px" },
    { key: "readCount", header: "reads", mono: true, align: "right", width: "70px" },
    { key: "enqueuedAt", header: "enqueued", mono: true, width: "200px" },
    {
      key: "message",
      header: "message",
      mono: true,
      render: (m) => <BodyCell value={m.message} />,
    },
  ];

  return (
    <div className="stack">
      <div className="stat-grid">
        <StatCard label="Queues" value={totals.queues} accent="var(--data-3)" />
        <StatCard
          label="Pending messages"
          value={totals.pending.toLocaleString()}
          accent="var(--data-2)"
        />
        <StatCard
          label="Archived"
          value={totals.archived.toLocaleString()}
          hint="across all queues"
        />
      </div>

      <Section eyebrow="pgmq" title="Queues">
        <DataTable
          columns={overviewColumns}
          rows={queues}
          getRowKey={(q) => q.name}
          empty="No pgmq queues. Create one with pgmq.create()."
        />
      </Section>

      {selectedRow ? (
        <Section
          eyebrow={selectedRow.name}
          title="Messages"
          actions={
            <div className="dgrid-toolbar" style={{ padding: 0, margin: 0 }}>
              <button
                type="button"
                className="type-chip"
                onClick={() => setSendOpen((v) => !v)}
              >
                {sendOpen ? "Close send" : "Send test message"}
              </button>
              <button
                type="button"
                className="type-chip"
                disabled={selectedRow.queueLength === 0}
                onClick={onPop}
              >
                Pop next
              </button>
              <button type="button" className="type-chip" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
          }
        >
          {sendOpen ? (
            <Surface className="teditor-insert" elevated={false}>
              <span className="eyebrow">Send to {selectedRow.name}</span>
              <textarea
                className="surface control mono"
                aria-label="Message JSON"
                rows={5}
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                spellCheck={false}
              />
              <div className="form-actions">
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => setSendOpen(false)}
                  disabled={sendBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={submitSend}
                  disabled={sendBusy}
                >
                  Send message
                </button>
              </div>
            </Surface>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className={msgLoading ? "dgrid-busy" : undefined}>
            <div className="stack">
              <div>
                <span className="eyebrow">
                  Live · pgmq.q_{selectedRow.name} · peek (non-consuming)
                </span>
                <DataTable
                  columns={liveColumns}
                  rows={live}
                  getRowKey={(m) => `live-${m.msgId}`}
                  empty="No visible messages."
                />
              </div>
              <div>
                <span className="eyebrow">
                  Archive · pgmq.a_{selectedRow.name}
                  {archiveCount != null ? ` · ${archiveCount.toLocaleString()} rows` : ""}
                  {archived.length >= MESSAGE_LIMIT
                    ? ` · showing newest ${MESSAGE_LIMIT}`
                    : ""}
                </span>
                <DataTable
                  columns={archivedColumns}
                  rows={archived}
                  getRowKey={(m) => `arch-${m.msgId}`}
                  empty="No archived messages."
                />
              </div>
            </div>
          </div>
        </Section>
      ) : null}
      {dialog}
    </div>
  );
}

export default QueuesClient;
