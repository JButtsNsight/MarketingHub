"use client";

import { useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { StatCard } from "../ui/StatCard";
import { Surface } from "../Surface";
import { useConfirm, type ConfirmOptions } from "../ui/AlertDialog";

/**
 * Database Webhooks (Studio → Database → Webhooks): browse every webhook (an
 * AFTER-row trigger that dispatches through supabase_functions.http_request →
 * pg_net) with its table, fired events, HTTP method, target URL, and enabled
 * state. Create / drop flow through the group-gated /api/console/webhooks
 * route, which delegates to the foundation `webhooks` lib for all SQL-safety
 * and the dedicated-role gate.
 *
 * Every mutation is DDL, so each goes behind the interrupting confirm modal
 * (useConfirm) — the guard sits on the write, never on browsing. Outbound HTTP
 * from Postgres is an SSRF/exfil surface: creating a webhook is refused until
 * cdk/sql/2026-08-07-scope-pg-net.sql scopes pg_net EXECUTE to the
 * `webhooks_admin` role, so the create control is disabled while `ready` is
 * false and the banner explains why.
 */

const EVENT_OPTIONS = ["insert", "update", "delete"] as const;
type WebhookEventOption = (typeof EVENT_OPTIONS)[number];

const METHOD_OPTIONS = ["POST", "GET"] as const;
type WebhookMethodOption = (typeof METHOD_OPTIONS)[number];

const DEFAULT_HEADERS = '{\n  "Content-Type": "application/json"\n}';

export interface WebhookDto {
  schema: string;
  table: string;
  name: string;
  events: WebhookEventOption[];
  enabled: boolean;
  url: string | null;
  method: string | null;
  definition: string;
}

export interface TableRefDto {
  schema: string;
  name: string;
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function eventBadges(hook: WebhookDto) {
  if (hook.events.length === 0) return <span className="mono">—</span>;
  return (
    <span className="campaign-actions">
      {hook.events.map((e) => (
        <Badge key={e} tone="var(--data-2)">
          {e}
        </Badge>
      ))}
    </span>
  );
}

function urlCell(hook: WebhookDto) {
  if (!hook.url) {
    return (
      <span className="mono" title={hook.definition}>
        — (see definition)
      </span>
    );
  }
  return (
    <span className="mono" title={hook.url}>
      {hook.url.length > 56 ? `${hook.url.slice(0, 55)}…` : hook.url}
    </span>
  );
}

export function WebhooksClient({
  initialWebhooks,
  availableTables,
  ready,
}: {
  initialWebhooks: WebhookDto[];
  availableTables: TableRefDto[];
  ready: boolean;
}) {
  const [webhooks, setWebhooks] = useState(initialWebhooks);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { confirm, dialog } = useConfirm();

  const reload = async () => {
    try {
      const res = await fetch("/api/console/webhooks");
      if (!res.ok) return;
      const body = (await res.json()) as { webhooks?: WebhookDto[] };
      setWebhooks(body.webhooks ?? []);
    } catch {
      // best-effort refresh; the table keeps its last good state
    }
  };

  const drop = async (hook: WebhookDto) => {
    const ok = await confirm({
      title: `Drop webhook ${hook.name}?`,
      message: (
        <>
          This permanently drops the <strong>{hook.name}</strong> trigger on{" "}
          <span className="mono">
            {hook.schema}.{hook.table}
          </span>
          . Rows changing on that table will no longer POST to the target URL.
          This cannot be undone.
        </>
      ),
      confirmLabel: "Drop webhook",
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch("/api/console/webhooks", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: hook.schema, table: hook.table, name: hook.name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Drop failed.");
        return;
      }
      await reload();
    } catch {
      setError("Network error — please try again.");
    }
  };

  const columns: Column<WebhookDto>[] = [
    {
      key: "table",
      header: "table",
      mono: true,
      render: (h) => `${h.schema}.${h.table}`,
    },
    { key: "name", header: "webhook", mono: true },
    { key: "events", header: "events", render: eventBadges },
    {
      key: "method",
      header: "method",
      width: "90px",
      render: (h) => <span className="mono">{h.method ?? "—"}</span>,
    },
    { key: "url", header: "target url", render: urlCell },
    {
      key: "enabled",
      header: "state",
      width: "110px",
      render: (h) =>
        h.enabled ? (
          <Badge tone="var(--ok)">enabled</Badge>
        ) : (
          <Badge tone="var(--warn)">disabled</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "110px",
      render: (h) => (
        <button type="button" className="type-chip" onClick={() => void drop(h)}>
          Drop
        </button>
      ),
    },
  ];

  const enabledCount = webhooks.filter((h) => h.enabled).length;

  return (
    <div className="stack">
      <Surface className="empty-state" elevated={false}>
        <p>
          Database webhooks dispatch through{" "}
          <span className="mono">supabase_functions.http_request</span> →{" "}
          <span className="mono">pg_net</span>. Outbound HTTP from Postgres is
          scoped to the <span className="mono">webhooks_admin</span> role by{" "}
          <span className="mono">cdk/sql/2026-08-07-scope-pg-net.sql</span>.{" "}
          {ready ? (
            <>That migration is applied — webhook creation is enabled.</>
          ) : (
            <strong>
              That migration is NOT applied yet, so creating a webhook is
              refused until it runs.
            </strong>
          )}
        </p>
      </Surface>

      <div className="stat-grid">
        <StatCard label="Webhooks" value={webhooks.length} accent="var(--data-2)" />
        <StatCard
          label="Enabled"
          value={enabledCount}
          hint={enabledCount === webhooks.length ? "all firing" : "some disabled"}
          accent="var(--data-3)"
        />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {creating ? (
        <WebhookForm
          availableTables={availableTables}
          confirm={confirm}
          onDone={(changed) => {
            setCreating(false);
            if (changed) void reload();
          }}
        />
      ) : null}

      <Section
        eyebrow="Trigger → http_request"
        title="Webhooks"
        actions={
          <button
            type="button"
            className="btn-primary"
            disabled={!ready}
            title={ready ? undefined : "Apply the pg_net scoping migration first."}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? "Close" : "New webhook"}
          </button>
        }
      >
        <DataTable
          columns={columns}
          rows={webhooks}
          getRowKey={(h) => `${h.schema}.${h.table}.${h.name}`}
          empty="No database webhooks."
        />
      </Section>
      {dialog}
    </div>
  );
}

/**
 * Create form. Pick a table, the row events to fire on, the target URL and
 * method, and optional request headers (JSON). Submitting opens the confirm
 * modal — the DDL guard — before anything is sent; the server (via the
 * foundation lib) re-validates every identifier against the live catalog and
 * refuses unless the webhooks_admin role exists.
 */
function WebhookForm({
  availableTables,
  confirm,
  onDone,
}: {
  availableTables: TableRefDto[];
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onDone: (changed: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [tableKey, setTableKey] = useState(
    availableTables.length > 0
      ? `${availableTables[0].schema}.${availableTables[0].name}`
      : "",
  );
  const [events, setEvents] = useState<Set<WebhookEventOption>>(new Set(["insert"]));
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState<WebhookMethodOption>("POST");
  const [headersText, setHeadersText] = useState(DEFAULT_HEADERS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleEvent = (e: WebhookEventOption) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });

  const submit = async () => {
    setError(null);

    if (!IDENTIFIER_RE.test(name)) {
      setError(
        "Enter a valid webhook name: a letter or underscore, then letters, digits or underscores.",
      );
      return;
    }
    const dot = tableKey.indexOf(".");
    if (dot < 0) {
      setError("Select a table.");
      return;
    }
    const schema = tableKey.slice(0, dot);
    const table = tableKey.slice(dot + 1);

    const selectedEvents = EVENT_OPTIONS.filter((e) => events.has(e));
    if (selectedEvents.length === 0) {
      setError("Select at least one event (insert / update / delete).");
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      setError("Enter a valid absolute URL.");
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      setError("URL must use http or https.");
      return;
    }

    // Optional headers: an empty box means "use the default"; otherwise the box
    // must parse as a flat JSON object of string → string.
    let headers: Record<string, string> | undefined;
    const trimmed = headersText.trim();
    if (trimmed.length > 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        setError("Headers must be valid JSON.");
        return;
      }
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        !Object.values(raw as Record<string, unknown>).every((v) => typeof v === "string")
      ) {
        setError("Headers must be a JSON object mapping string keys to string values.");
        return;
      }
      headers = raw as Record<string, string>;
    }

    const ok = await confirm({
      title: `Create webhook ${name}?`,
      message: (
        <>
          Create an AFTER-row trigger <strong>{name}</strong> on{" "}
          <span className="mono">{tableKey}</span> that fires a {method} request
          to <span className="mono">{parsedUrl.origin}</span> on{" "}
          {selectedEvents.join(" / ")}. Every matching row change will make an
          outbound HTTP call through pg_net.
        </>
      ),
      confirmLabel: "Create webhook",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const res = await fetch("/api/console/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema,
          table,
          name,
          events: selectedEvents,
          url,
          method,
          ...(headers ? { headers } : {}),
        }),
      });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(parsed?.error ?? "Request failed.");
        setBusy(false);
        return;
      }
      onDone(true);
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  return (
    <Surface className="teditor-insert" elevated={false}>
      <span className="eyebrow">New webhook</span>

      <div className="field">
        <label htmlFor="wh-name">name</label>
        <input
          id="wh-name"
          className="surface control mono"
          type="text"
          placeholder="webhook_name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="wh-table">table</label>
        {availableTables.length === 0 ? (
          <span className="teditor-test">No tables available.</span>
        ) : (
          <select
            id="wh-table"
            className="surface control mono"
            value={tableKey}
            onChange={(e) => setTableKey(e.target.value)}
          >
            {availableTables.map((t) => {
              const key = `${t.schema}.${t.name}`;
              return (
                <option key={key} value={key}>
                  {key}
                </option>
              );
            })}
          </select>
        )}
      </div>

      <div className="field">
        <label>events</label>
        <div className="campaign-actions">
          {EVENT_OPTIONS.map((e) => (
            <label key={e} className="teditor-null">
              <input
                type="checkbox"
                checked={events.has(e)}
                onChange={() => toggleEvent(e)}
              />{" "}
              {e}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="wh-method">method</label>
        <select
          id="wh-method"
          className="surface control mono"
          value={method}
          onChange={(e) => setMethod(e.target.value as WebhookMethodOption)}
        >
          {METHOD_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="wh-url">url</label>
        <input
          id="wh-url"
          className="surface control mono"
          type="text"
          placeholder="https://example.com/hook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="wh-headers">headers (JSON, optional)</label>
        <textarea
          id="wh-headers"
          className="surface control mono"
          rows={4}
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
        />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button
          type="button"
          className="type-chip"
          onClick={() => onDone(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
          Create webhook
        </button>
      </div>
    </Surface>
  );
}

export default WebhooksClient;
