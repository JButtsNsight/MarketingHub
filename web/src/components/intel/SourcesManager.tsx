"use client";

// Competitor-intel sources list + create/edit/delete. Client component: all
// data flows through the group-gated /api/intel routes, so provisioning gaps
// and API failures surface as honest states (see States.tsx) rather than a
// crashed page. Delete is a two-step inline confirm (ListActions precedent)
// and warns that documents/chunks cascade.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "../Surface";
import { deleteSource, listSources, IntelApiError } from "./api";
import { ErrorState, LoadingState } from "./States";
import { SourceForm } from "./SourceForm";
import { URL_FETCH_NOTE } from "./status";
import type { IntelSourceSummary } from "./types";

function count(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

export function SourcesManager() {
  const [sources, setSources] = useState<IntelSourceSummary[] | null>(null);
  const [error, setError] = useState<IntelApiError | null>(null);
  const [form, setForm] = useState<"closed" | "create" | IntelSourceSummary>("closed");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSources(await listSources());
    } catch (err) {
      setSources(null);
      setError(
        err instanceof IntelApiError
          ? err
          : new IntelApiError("http", "Loading sources failed."),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setDeleteError(null);
    try {
      await deleteSource(id);
      setConfirmingId(null);
      await load();
    } catch (err) {
      setConfirmingId(null);
      setDeleteError(
        err instanceof IntelApiError ? err.message : "Delete failed. Please try again.",
      );
    }
  };

  const columns: Column<IntelSourceSummary>[] = [
    {
      key: "name",
      header: "name",
      render: (s) => <Link href={`/intel/sources/${s.id}`}>{s.name}</Link>,
    },
    {
      key: "kind",
      header: "kind",
      width: "110px",
      render: (s) => (
        <Badge title={s.kind === "url" ? `${s.url ?? ""} — ${URL_FETCH_NOTE}` : undefined}>
          {s.kind}
        </Badge>
      ),
    },
    {
      key: "documents",
      header: "documents",
      mono: true,
      align: "right",
      width: "110px",
      render: (s) => count(s.document_count),
    },
    {
      key: "chunks",
      header: "chunks",
      mono: true,
      align: "right",
      width: "90px",
      render: (s) => count(s.chunk_count),
    },
    {
      key: "updated",
      header: "updated",
      mono: true,
      width: "120px",
      render: (s) => s.updated_at?.slice(0, 10) ?? "—",
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "190px",
      render: (s) => (
        <span className="campaign-actions">
          <button type="button" className="type-chip" onClick={() => setForm(s)}>
            Edit
          </button>
          <button type="button" className="type-chip" onClick={() => void onDelete(s.id)}>
            {confirmingId === s.id ? "Really delete?" : "Delete"}
          </button>
        </span>
      ),
    },
  ];

  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (sources === null) return <LoadingState label="Loading sources…" />;

  return (
    <div className="stack">
      <div className="form-actions">
        {form === "closed" ? (
          <button type="button" className="btn-primary" onClick={() => setForm("create")}>
            New source
          </button>
        ) : null}
      </div>

      {form !== "closed" ? (
        <SourceForm
          initial={form === "create" ? undefined : form}
          onSaved={() => {
            setForm("closed");
            void load();
          }}
          onCancel={() => setForm("closed")}
        />
      ) : null}

      {deleteError ? (
        <p className="form-error" role="alert">
          {deleteError}
        </p>
      ) : null}

      {sources.length === 0 ? (
        <Surface className="empty-state" glint>
          <h2>No sources yet</h2>
          <p>Create a source, then paste competitor text into it.</p>
        </Surface>
      ) : (
        <DataTable
          columns={columns}
          rows={sources}
          getRowKey={(s) => s.id}
          empty="No sources."
        />
      )}
    </div>
  );
}

export default SourcesManager;
