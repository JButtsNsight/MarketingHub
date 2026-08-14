"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { useConfirm } from "@/components/ui/AlertDialog";
import { Guide } from "@/components/guide/Guide";
import { NewCampaignDialog } from "./NewCampaignDialog";
import { PushContactsDialog } from "./PushContactsDialog";
import {
  BISON_STATUS_FILTERS,
  type BisonCampaign,
  type BisonPage,
} from "@/lib/email/bison.shared";

/**
 * Email Campaign Center (EmailBison). Marketing tier sees the dashboard;
 * connecting/disconnecting the account is admin-only. The API key never
 * reaches this component — status carries the instance host + workspace only.
 */

interface ConnectionStatus {
  provisioned: boolean;
  connected: boolean;
  baseUrl?: string;
  workspaceName?: string | null;
}

const LINK_BTN: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
};

const STATUS_TONE: Record<string, string | undefined> = {
  active: "var(--ok)",
  launching: "var(--run)",
  queued: "var(--run)",
  completed: "var(--ok)",
  paused: "var(--warn)",
  stopped: "var(--warn)",
  failed: "var(--fail)",
};

function toneFor(status: string): string | undefined {
  return STATUS_TONE[status.toLowerCase()];
}

const COLUMNS: Column<BisonCampaign>[] = [
  {
    key: "name",
    header: "Campaign",
    render: (c) => c.name,
  },
  {
    key: "status",
    header: "Status",
    render: (c) => <Badge tone={toneFor(c.status)}>{c.status}</Badge>,
  },
  { key: "totalLeads", header: "Leads", mono: true, align: "right" },
  { key: "emailsSent", header: "Sent", mono: true, align: "right" },
  { key: "uniqueOpens", header: "Opens", mono: true, align: "right" },
  { key: "uniqueReplies", header: "Replies", mono: true, align: "right" },
  { key: "interested", header: "Interested", mono: true, align: "right" },
  { key: "bounced", header: "Bounced", mono: true, align: "right" },
  { key: "unsubscribed", header: "Unsubs", mono: true, align: "right" },
  {
    key: "updatedAt",
    header: "Updated",
    mono: true,
    render: (c) => (c.updatedAt ? c.updatedAt.slice(0, 10) : "—"),
  },
];

export function EmailCenter({ admin }: { admin: boolean }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<BisonCampaign[]>([]);
  const [meta, setMeta] = useState<BisonPage | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [listState, setListState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [listError, setListError] = useState<string | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [connectState, setConnectState] = useState<"idle" | "busy">("idle");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<{
    id: number;
    action: "pause" | "resume";
  } | null>(null);
  const [actionError, setActionError] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [pushFor, setPushFor] = useState<BisonCampaign | null>(null);
  const [creating, setCreating] = useState(false);
  const { confirm, dialog } = useConfirm();

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

  // Monotonic fetch token: a slow response for an ABANDONED filter/page must
  // never overwrite the view the user has since navigated to.
  const fetchSeq = useRef(0);
  const loadCampaigns = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setListState("loading");
    setListError(null);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (filter) params.set("status", filter);
      const res = await fetch(`/api/email/campaigns?${params}`);
      const body = (await res.json()) as {
        connected?: boolean;
        campaigns?: BisonCampaign[];
        meta?: BisonPage;
        error?: string;
      };
      if (seq !== fetchSeq.current) return; // stale — a newer load owns the view
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      setCampaigns(body.campaigns ?? []);
      setMeta(body.meta ?? null);
      setListState("idle");
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      setListState("error");
      setListError(err instanceof Error ? err.message : "load failed");
    }
  }, [filter, page]);
  // Post-mutation refetches go through the LATEST loader — a mutation started
  // before a filter/page change must not refetch (and race) the old view.
  const loadCampaignsRef = useRef(loadCampaigns);
  useEffect(() => {
    loadCampaignsRef.current = loadCampaigns;
  }, [loadCampaigns]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (status?.connected) void loadCampaigns();
  }, [status?.connected, loadCampaigns]);

  async function connect() {
    setConnectState("busy");
    setConnectError(null);
    try {
      const res = await fetch("/api/email/connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrlInput, apiKey: tokenInput }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      setTokenInput("");
      await loadStatus();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "connect failed");
    } finally {
      setConnectState("idle");
    }
  }

  async function runAction(c: BisonCampaign, action: "pause" | "resume") {
    // Pause is safe to fire immediately; resume restarts real sending.
    if (action === "resume") {
      const ok = await confirm({
        title: "Resume sending?",
        message: `“${c.name}” starts sending again as soon as EmailBison picks it up.`,
        confirmLabel: "Resume",
      });
      if (!ok) return;
    }
    setActionError(null);
    setNotice(null);
    setRowBusy({ id: c.id, action });
    try {
      const res = await fetch(`/api/email/campaigns/${c.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`);
      // No optimistic state: the table only says what a refetch confirmed.
      await loadCampaignsRef.current();
    } catch (err) {
      setActionError({
        message: err instanceof Error ? err.message : `${action} failed`,
        retry: () => void runAction(c, action),
      });
    } finally {
      setRowBusy(null);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect EmailBison?",
      message:
        "Removes the stored API token. Campaign data stays in EmailBison; reconnecting needs a token paste.",
      confirmLabel: "Disconnect",
    });
    if (!ok) return;
    const res = await fetch("/api/email/connection", { method: "DELETE" });
    if (res.ok) {
      setCampaigns([]);
      setMeta(null);
      await loadStatus();
    }
  }

  if (statusError) {
    return <p className="form-error">EmailBison status unavailable: {statusError}</p>;
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
    if (!admin) {
      return (
        <p className="field-note">
          Not connected — an admin can link the EmailBison account here.
        </p>
      );
    }
    return (
      <Surface className="upload-form" style={{ maxWidth: 560 }}>
        <Guide id="email.center.connect">
          <div className="field">
            <label htmlFor="eb-url">EmailBison instance URL</label>
            <input
              id="eb-url"
              className="control surface"
              placeholder="dedi.emailbison.com"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
            />
          </div>
        </Guide>
        <div className="field">
          <label htmlFor="eb-token">API token</label>
          <input
            id="eb-token"
            className="control surface"
            type="password"
            placeholder="Settings → Developer API → New API Token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            autoComplete="off"
          />
        </div>
        {connectError ? <p className="form-error">{connectError}</p> : null}
        <div>
          <button
            type="button"
            className="btn-primary"
            disabled={connectState === "busy" || tokenInput.trim() === ""}
            onClick={() => void connect()}
          >
            {connectState === "busy" ? "Validating…" : "Connect"}
          </button>
        </div>
      </Surface>
    );
  }

  const host = status.baseUrl?.replace(/^https:\/\//, "") ?? "";
  const baseUrl = status.baseUrl;
  // Mutations are serialized: while one is in flight (or the table is
  // refetching) every mutating row control disables — no racing actions.
  const actionsDisabled = rowBusy !== null || listState === "loading";
  const columns: Column<BisonCampaign>[] = [
    ...COLUMNS,
    {
      key: "actions",
      header: "Actions",
      render: (c) => {
        const s = c.status.toLowerCase();
        const busyHere = rowBusy?.id === c.id;
        return (
          <span style={{ display: "inline-flex", gap: 6 }}>
            {s === "active" || s === "launching" ? (
              <Guide id="email.center.pause">
                <button
                  type="button"
                  className="type-chip"
                  disabled={actionsDisabled}
                  onClick={() => void runAction(c, "pause")}
                >
                  {busyHere && rowBusy?.action === "pause"
                    ? "Pausing…"
                    : "Pause"}
                </button>
              </Guide>
            ) : null}
            {s === "paused" ? (
              <Guide id="email.center.resume">
                <button
                  type="button"
                  className="type-chip"
                  disabled={actionsDisabled}
                  onClick={() => void runAction(c, "resume")}
                >
                  {busyHere && rowBusy?.action === "resume"
                    ? "Resuming…"
                    : "Resume"}
                </button>
              </Guide>
            ) : null}
            <Guide id="email.center.push">
              <button
                type="button"
                className="type-chip"
                disabled={actionsDisabled}
                onClick={() => {
                  setNotice(null);
                  setActionError(null);
                  setPushFor(c);
                }}
              >
                Push contacts
              </button>
            </Guide>
          </span>
        );
      },
    },
  ];
  return (
    <div>
      {dialog}
      {pushFor ? (
        <PushContactsDialog
          campaign={{ id: pushFor.id, name: pushFor.name }}
          onClose={() => setPushFor(null)}
          onPushed={(r) => {
            setPushFor(null);
            setNotice(
              `${r.attached} attached · ${r.skipped} skipped — leads can take ~5 minutes to appear on active campaigns`,
            );
            void loadCampaignsRef.current();
          }}
        />
      ) : null}
      {creating ? (
        <NewCampaignDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setNotice(
              <>
                Draft created — finish the sequence in{" "}
                <a href={baseUrl} target="_blank" rel="noreferrer">
                  EmailBison ↗
                </a>
              </>,
            );
            void loadCampaignsRef.current();
          }}
        />
      ) : null}
      <div className="page-head">
        <span className="field-note">
          Connected to <span className="mono">{host}</span>
          {status.workspaceName ? <> · {status.workspaceName}</> : null}
        </span>
        <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
          <Guide id="email.center.status-filter">
            <select
              className="control surface"
              style={{ width: "auto" }}
              aria-label="Status filter"
              value={filter}
              onChange={(e) => {
                setPage(1);
                setFilter(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              {BISON_STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Guide>
          <Guide id="email.center.open">
            <a href={status.baseUrl} target="_blank" rel="noreferrer">
              Open in EmailBison ↗
            </a>
          </Guide>
          <Guide id="email.center.new-campaign">
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setNotice(null);
                setActionError(null);
                setCreating(true);
              }}
            >
              New campaign
            </button>
          </Guide>
          {admin ? (
            <Guide id="email.center.disconnect">
              <button
                type="button"
                className="user-menu-signout"
                style={{ background: "none", border: "none", cursor: "pointer" }}
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            </Guide>
          ) : null}
        </span>
      </div>
      {notice ? (
        <p className="field-note" role="status">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError.message}{" "}
          <button
            type="button"
            className="user-menu-signout"
            style={LINK_BTN}
            onClick={actionError.retry}
          >
            Retry
          </button>
        </p>
      ) : null}
      {/* Load failures report inline; already-loaded rows stay visible. */}
      {listState === "error" ? (
        <p className="form-error" role="alert">
          {listError}{" "}
          <button
            type="button"
            className="user-menu-signout"
            style={LINK_BTN}
            onClick={() => void loadCampaigns()}
          >
            Retry
          </button>
        </p>
      ) : null}
      <Guide id="email.center.table">
        <div>
          <DataTable
            columns={columns}
            rows={campaigns}
            getRowKey={(c) => c.uuid || String(c.id)}
            empty={listState === "loading" ? "Loading…" : "No campaigns yet."}
          />
        </div>
      </Guide>
      {meta && meta.lastPage > 1 ? (
        <div className="page-head" style={{ marginTop: 10 }}>
          <span className="count mono">
            page {meta.currentPage} of {meta.lastPage} · {meta.total} campaigns
          </span>
          <span style={{ display: "inline-flex", gap: 10 }}>
            <button
              type="button"
              className="user-menu-signout"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              disabled={meta.currentPage <= 1 || listState === "loading"}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="user-menu-signout"
              style={{ background: "none", border: "none", cursor: "pointer" }}
              disabled={meta.currentPage >= meta.lastPage || listState === "loading"}
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
