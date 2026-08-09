"use client";

// One source: metadata, its documents with live embedding lifecycle, and the
// paste-text ingestion form. Statuses are the DB truth (pending → processing
// → embedded | error) rendered with governed StatusPills, plus an honest
// queue-drain note while anything is still pending and a plain stub label
// when embeddings come from the deterministic stub provider. Loads via
// GET /api/intel/sources/:id (source + document summaries in one call).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { IntelSource } from "@/lib/intel/schema";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { KeyValue } from "@/components/ui/KeyValue";
import { Section } from "@/components/ui/Section";
import { StatusPill } from "@/components/ui/StatusPill";
import { Surface } from "../Surface";
import { deleteDocument, getSourceWithDocuments, IntelApiError } from "./api";
import { ProviderBadge } from "./ProviderBadge";
import { ErrorState, LoadingState } from "./States";
import { AddDocumentForm } from "./AddDocumentForm";
import { documentStatusKind, PENDING_NOTE, URL_FETCH_NOTE } from "./status";
import type { EmbeddingProviderInfo, IntelDocumentSummary } from "./types";

export function SourceDetail({
  sourceId,
  provider,
}: {
  sourceId: string;
  provider: EmbeddingProviderInfo;
}) {
  const [source, setSource] = useState<IntelSource | null>(null);
  const [documents, setDocuments] = useState<IntelDocumentSummary[] | null>(null);
  const [error, setError] = useState<IntelApiError | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { source: s, documents: docs } = await getSourceWithDocuments(sourceId);
      setSource(s);
      setDocuments(docs);
    } catch (err) {
      setSource(null);
      setDocuments(null);
      setError(
        err instanceof IntelApiError
          ? err
          : new IntelApiError("http", "Loading the source failed."),
      );
    }
  }, [sourceId]);

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
      await deleteDocument(id);
      setConfirmingId(null);
      await load();
    } catch (err) {
      setConfirmingId(null);
      setDeleteError(
        err instanceof IntelApiError ? err.message : "Delete failed. Please try again.",
      );
    }
  };

  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (source === null || documents === null) {
    return <LoadingState label="Loading source…" />;
  }

  const awaiting = documents.filter(
    (d) => d.status === "pending" || d.status === "processing",
  ).length;

  const columns: Column<IntelDocumentSummary>[] = [
    {
      key: "title",
      header: "document",
      render: (d) => <Link href={`/intel/documents/${d.id}`}>{d.title}</Link>,
    },
    {
      key: "status",
      header: "status",
      width: "140px",
      render: (d) => (
        <StatusPill status={documentStatusKind(d.status)}>{d.status}</StatusPill>
      ),
    },
    {
      key: "chunks",
      header: "chunks",
      mono: true,
      align: "right",
      width: "90px",
      render: (d) => d.chunk_count,
    },
    {
      key: "detail",
      header: "detail",
      render: (d) =>
        d.status === "error" ? (
          <span className="form-error">{d.error ?? "embedding failed"}</span>
        ) : d.status === "pending" || d.status === "processing" ? (
          <span className="muted">awaiting embedding</span>
        ) : (
          ""
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "130px",
      render: (d) => (
        <button type="button" className="type-chip" onClick={() => void onDelete(d.id)}>
          {confirmingId === d.id ? "Really delete?" : "Delete"}
        </button>
      ),
    },
  ];

  return (
    <div className="stack">
      <Section title={source.name} description={<ProviderBadge info={provider} />}>
        <KeyValue
          items={[
            { label: "Kind", value: source.kind },
            ...(source.kind === "url"
              ? [
                  { label: "URL", value: source.url ?? "—", mono: true },
                  { label: "Ingestion", value: `paste-text only — ${URL_FETCH_NOTE}` },
                ]
              : []),
            ...(source.notes ? [{ label: "Notes", value: source.notes }] : []),
            { label: "Created", value: source.created_at?.slice(0, 10) ?? "—", mono: true },
          ]}
        />
      </Section>

      <Section
        title="Documents"
        description={
          awaiting > 0 ? (
            <>
              {awaiting} awaiting embedding — {PENDING_NOTE}
            </>
          ) : undefined
        }
        actions={
          <button type="button" className="type-chip" onClick={() => void load()}>
            Refresh
          </button>
        }
      >
        {deleteError ? (
          <p className="form-error" role="alert">
            {deleteError}
          </p>
        ) : null}

        {documents.length === 0 ? (
          <Surface className="empty-state" glint={false} elevated={false}>
            <h2>No documents yet</h2>
            <p>
              Paste competitor text below — it&apos;s chunked and queued for
              embedding, then becomes searchable on the Search page.
            </p>
          </Surface>
        ) : (
          <DataTable
            columns={columns}
            rows={documents}
            getRowKey={(d) => d.id}
            empty="No documents."
          />
        )}

        <div className="form-actions">
          <AddDocumentForm sourceId={sourceId} onAdded={() => void load()} />
        </div>
      </Section>
    </div>
  );
}

export default SourceDetail;
