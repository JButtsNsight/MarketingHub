"use client";

import { useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { useConfirm } from "../ui/AlertDialog";

/**
 * Extensions manager (Studio Database → Extensions). Lists every extension
 * pg-meta knows about (installed + available) with its default/installed
 * version, target schema, and comment. Enable (CREATE EXTENSION) and drop
 * (DROP EXTENSION) are DDL run as superuser — both go behind the interrupting
 * confirm modal (useConfirm), never a standing banner. Browsing needs no
 * confirm. All writes flow through the group-gated /api/console/extensions
 * route, which re-validates the extension name against the live catalog.
 */

export interface ExtensionDto {
  name: string;
  schema: string | null;
  default_version: string;
  installed_version: string | null;
  comment: string | null;
}

export function ExtensionsClient({
  initialExtensions,
}: {
  initialExtensions: ExtensionDto[];
}) {
  const [extensions, setExtensions] = useState(initialExtensions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Modal confirmation before any DDL (enable/drop).
  const { confirm, dialog } = useConfirm();

  const refresh = async () => {
    try {
      const res = await fetch("/api/console/extensions");
      if (!res.ok) return;
      const body = (await res.json()) as { extensions?: ExtensionDto[] };
      setExtensions(body.extensions ?? []);
    } catch {
      // best-effort refresh; the row action already reports its own errors
    }
  };

  const enable = async (ext: ExtensionDto) => {
    const ok = await confirm({
      title: `Enable ${ext.name}?`,
      message:
        "Enabling runs CREATE EXTENSION as the database superuser and can add " +
        "tables, functions, and schemas to the database. Continue?",
      confirmLabel: "Enable extension",
    });
    if (!ok) return;
    setBusy(ext.name);
    setError(null);
    try {
      const res = await fetch("/api/console/extensions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: ext.name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Enabling the extension failed.");
        return;
      }
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  };

  const drop = async (ext: ExtensionDto) => {
    const ok = await confirm({
      title: `Drop ${ext.name}?`,
      message:
        "Dropping runs DROP EXTENSION as the database superuser and can cascade " +
        "to objects that depend on it. This cannot be undone from here. Continue?",
      confirmLabel: "Drop extension",
    });
    if (!ok) return;
    setBusy(ext.name);
    setError(null);
    try {
      const res = await fetch("/api/console/extensions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: ext.name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Dropping the extension failed.");
        return;
      }
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  };

  const columns: Column<ExtensionDto>[] = [
    { key: "name", header: "extension", mono: true },
    {
      key: "state",
      header: "state",
      width: "130px",
      render: (e) =>
        e.installed_version ? (
          <Badge tone="var(--ok)">{e.installed_version}</Badge>
        ) : (
          <Badge>available</Badge>
        ),
    },
    {
      key: "default_version",
      header: "default",
      mono: true,
      width: "100px",
      render: (e) => e.default_version || "—",
    },
    {
      key: "schema",
      header: "schema",
      mono: true,
      width: "120px",
      render: (e) => e.schema ?? "—",
    },
    {
      key: "comment",
      header: "comment",
      render: (e) =>
        e.comment ? (
          <span title={e.comment}>
            {e.comment.length > 72 ? `${e.comment.slice(0, 71)}…` : e.comment}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "160px",
      render: (e) =>
        e.installed_version ? (
          <button
            type="button"
            className="type-chip"
            disabled={busy === e.name}
            onClick={() => void drop(e)}
          >
            {busy === e.name ? "Working…" : "Drop"}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            disabled={busy === e.name}
            onClick={() => void enable(e)}
          >
            {busy === e.name ? "Working…" : "Enable"}
          </button>
        ),
    },
  ];

  return (
    <div className="stack">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <DataTable
        columns={columns}
        rows={extensions}
        getRowKey={(e) => e.name}
        empty="No extensions reported."
      />
      {dialog}
    </div>
  );
}

export default ExtensionsClient;
