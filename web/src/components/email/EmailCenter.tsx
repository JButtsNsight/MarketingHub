"use client";

import { useCallback, useEffect, useState } from "react";
import { Surface } from "@/components/Surface";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { useConfirm } from "@/components/ui/AlertDialog";
import { Guide } from "@/components/guide/Guide";
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

  const loadCampaigns = useCallback(async () => {
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
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      setCampaigns(body.campaigns ?? []);
      setMeta(body.meta ?? null);
      setListState("idle");
    } catch (err) {
      setListState("error");
      setListError(err instanceof Error ? err.message : "load failed");
    }
  }, [filter, page]);

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
  return (
    <div>
      {dialog}
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
              Open EmailBison ↗
            </a>
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
      {listState === "error" ? (
        <p className="form-error">
          {listError}{" "}
          <button
            type="button"
            className="user-menu-signout"
            style={{ background: "none", border: "none", cursor: "pointer" }}
            onClick={() => void loadCampaigns()}
          >
            Retry
          </button>
        </p>
      ) : (
        <Guide id="email.center.table">
          <div>
            <DataTable
              columns={COLUMNS}
              rows={campaigns}
              getRowKey={(c) => c.uuid || String(c.id)}
              empty={
                listState === "loading" ? "Loading…" : "No campaigns yet."
              }
            />
          </div>
        </Guide>
      )}
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
