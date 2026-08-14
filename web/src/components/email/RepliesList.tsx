"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Guide } from "@/components/guide/Guide";
import {
  type BisonPage,
  type BisonReply,
  type BisonReplyFolder,
  type BisonReplyStatusFilter,
} from "@/lib/email/bison.shared";

/**
 * Master Inbox (EmailBison's name for its shared reply inbox). Their IA on
 * the app's design tokens: folders are tabs in their order, threads carry
 * their labels as chips, unread rows are bold. Read-only — replying stays in
 * EmailBison. The API key never reaches this component.
 */

interface ConnectionStatus {
  provisioned: boolean;
  connected: boolean;
  baseUrl?: string;
}

/** EmailBison's Master Inbox folder tabs, their order and their names. */
const FOLDER_TABS: { key: BisonReplyFolder; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "sent", label: "Sent" },
  { key: "spam", label: "Spam" },
  { key: "bounced", label: "Bounces" },
];

const STATUS_OPTIONS: { value: "" | BisonReplyStatusFilter; label: string }[] =
  [
    { value: "", label: "All replies" },
    { value: "interested", label: "Interested" },
    { value: "automated_reply", label: "Automated reply" },
    { value: "not_automated_reply", label: "Not automated" },
  ];

const PREVIEW_CHARS = 120;

const LINK_BTN: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
};

/** Unread threads render bold, exactly like EmailBison's Master Inbox. */
function unreadWeight(r: BisonReply, node: ReactNode): ReactNode {
  return <span style={r.read ? undefined : { fontWeight: 600 }}>{node}</span>;
}

const COLUMNS: Column<BisonReply>[] = [
  {
    key: "from",
    header: "From",
    render: (r) =>
      unreadWeight(r, r.fromName ? `${r.fromName} — ${r.fromEmail}` : r.fromEmail),
  },
  {
    key: "subject",
    header: "Subject",
    render: (r) => unreadWeight(r, r.subject || "(no subject)"),
  },
  {
    key: "body",
    header: "Preview",
    render: (r) =>
      r.body.length > PREVIEW_CHARS
        ? `${r.body.slice(0, PREVIEW_CHARS)}…`
        : r.body,
  },
  {
    key: "labels",
    header: "Labels",
    render: (r) => (
      <span style={{ display: "inline-flex", gap: 6 }}>
        {r.interested ? <Badge tone="var(--ok)">Interested</Badge> : null}
        {r.folder === "bounced" ? <Badge tone="var(--fail)">Bounce</Badge> : null}
      </span>
    ),
  },
  {
    key: "campaignId",
    header: "Campaign",
    mono: true,
    align: "right",
    render: (r) => (r.campaignId ? r.campaignId : "—"),
  },
  {
    key: "dateReceived",
    header: "Received",
    mono: true,
    render: (r) => (r.dateReceived ? r.dateReceived.slice(0, 10) : "—"),
  },
];

export function RepliesList() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [folder, setFolder] = useState<BisonReplyFolder>("inbox");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [replies, setReplies] = useState<BisonReply[]>([]);
  const [meta, setMeta] = useState<BisonPage | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [listError, setListError] = useState<string | null>(null);
  // Monotonic fetch token: a slow response for an ABANDONED folder/filter/page
  // must never overwrite the view the user has since navigated to.
  const fetchSeq = useRef(0);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const res = await fetch("/api/email/connection");
      const body = (await res.json()) as ConnectionStatus & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      setStatus(body);
    } catch (err) {
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : "status failed");
    }
  }, []);

  const loadReplies = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setListState("loading");
    setListError(null);
    try {
      const params = new URLSearchParams({ folder, page: String(page) });
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/email/replies?${params}`);
      const body = (await res.json()) as {
        connected?: boolean;
        replies?: BisonReply[];
        meta?: BisonPage;
        error?: string;
      };
      if (seq !== fetchSeq.current) return; // stale — a newer load owns the view
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      // Disconnected between loads — show the honest state, not an empty inbox.
      if (body.connected === false) {
        setStatus((s) => (s ? { ...s, connected: false } : s));
        setListState("idle");
        return;
      }
      setReplies(body.replies ?? []);
      setMeta(body.meta ?? null);
      setListState("idle");
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      // Loaded rows stay put — only the inline error line reports the failure.
      setListState("error");
      setListError(err instanceof Error ? err.message : "load failed");
    }
  }, [folder, statusFilter, page]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status?.connected) void loadReplies();
  }, [status?.connected, loadReplies]);

  if (statusError) {
    return (
      <p className="form-error">EmailBison status unavailable: {statusError}</p>
    );
  }
  if (!status) return <p className="field-note">Loading…</p>;
  if (!status.provisioned) {
    return (
      <p className="field-note">
        EmailBison secret not provisioned on this deployment.
      </p>
    );
  }
  if (!status.connected) {
    return (
      <p className="field-note">
        Not connected — link EmailBison on the Campaigns tab.
      </p>
    );
  }

  return (
    <div>
      <div className="page-head">
        <Guide id="email.center.replies-folders">
          <div
            className="tabs"
            role="tablist"
            aria-label="Folder"
            style={{ marginBottom: 0 }}
          >
            {FOLDER_TABS.map((f) => {
              const on = folder === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={on ? "tab on" : "tab"}
                  // Inline style would beat `.tab.on`'s background — only the
                  // inactive tabs neutralize the native button chrome.
                  style={{
                    border: "none",
                    cursor: "pointer",
                    ...(on ? {} : { background: "none" }),
                  }}
                  onClick={() => {
                    setPage(1);
                    setFolder(f.key);
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </Guide>
        <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
          <Guide id="email.center.replies-status">
            <select
              className="control surface"
              style={{ width: "auto" }}
              aria-label="Reply filter"
              value={statusFilter}
              onChange={(e) => {
                setPage(1);
                setStatusFilter(e.target.value);
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Guide>
          <a href={status.baseUrl} target="_blank" rel="noreferrer">
            Open in EmailBison ↗
          </a>
        </span>
      </div>
      {listState === "error" ? (
        <p className="form-error" role="alert">
          {listError}{" "}
          <button
            type="button"
            className="user-menu-signout"
            style={LINK_BTN}
            onClick={() => void loadReplies()}
          >
            Retry
          </button>
        </p>
      ) : null}
      <Guide id="email.center.replies-table">
        <div>
          <DataTable
            columns={COLUMNS}
            rows={replies}
            getRowKey={(r) => String(r.id)}
            empty={listState === "loading" ? "Loading…" : "No replies."}
          />
        </div>
      </Guide>
      {meta && meta.lastPage > 1 ? (
        <div className="page-head" style={{ marginTop: 10 }}>
          <span className="count mono">
            page {meta.currentPage} of {meta.lastPage} · {meta.total} replies
          </span>
          <span style={{ display: "inline-flex", gap: 10 }}>
            <button
              type="button"
              className="user-menu-signout"
              style={LINK_BTN}
              disabled={meta.currentPage <= 1 || listState === "loading"}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="user-menu-signout"
              style={LINK_BTN}
              disabled={
                meta.currentPage >= meta.lastPage || listState === "loading"
              }
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default RepliesList;
