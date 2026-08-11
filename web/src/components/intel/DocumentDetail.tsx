"use client";

// One document: its embedding lifecycle, chunk progress, and the pasted
// content. Loads the full row (GET /api/intel/documents/:id) plus the honest
// progress endpoint (GET .../status); if the status call fails the chunks row
// says "not reported" rather than inventing zeros. A fresh document says
// plainly that it's waiting on the worker (queue drains ~every 30s), a
// stub-embedded one is labeled illustrative, and an errored one shows the
// consumer's error message verbatim.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { IntelDocument } from "@/lib/intel/schema";
import { KeyValue, type KeyValueItem } from "@/components/ui/KeyValue";
import { Section } from "@/components/ui/Section";
import { StatusPill } from "@/components/ui/StatusPill";
import { getChunkStatus, getDocument, IntelApiError } from "./api";
import { ProviderBadge } from "./ProviderBadge";
import { ErrorState, LoadingState } from "./States";
import { documentStatusKind, PENDING_NOTE } from "./status";
import type { ChunkStatusSummary, EmbeddingProviderInfo } from "./types";

export function DocumentDetail({
  documentId,
  provider,
}: {
  documentId: string;
  provider: EmbeddingProviderInfo;
}) {
  const [doc, setDoc] = useState<IntelDocument | null>(null);
  const [chunkStatus, setChunkStatus] = useState<ChunkStatusSummary | null>(null);
  const [error, setError] = useState<IntelApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [document, status] = await Promise.all([
        getDocument(documentId),
        // Progress is best-effort: a failed status call degrades to "not
        // reported" instead of hiding the document.
        getChunkStatus(documentId).catch(() => null),
      ]);
      setDoc(document);
      setChunkStatus(status);
    } catch (err) {
      setDoc(null);
      setChunkStatus(null);
      setError(
        err instanceof IntelApiError
          ? err
          : new IntelApiError("http", "Loading the document failed."),
      );
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (doc === null) return <LoadingState label="Loading document…" />;

  const pending = doc.status === "pending" || doc.status === "processing";

  const items: KeyValueItem[] = [
    { label: "Source", value: <Link href={`/intel/sources/${doc.source_id}`}>view source</Link> },
    {
      label: "Status",
      value: <StatusPill status={documentStatusKind(doc.status)}>{doc.status}</StatusPill>,
    },
    {
      label: "Chunks",
      value: chunkStatus
        ? `${chunkStatus.embedded}/${chunkStatus.total} embedded`
        : "not reported",
      mono: true,
    },
    ...(chunkStatus && chunkStatus.models.length > 0
      ? [{ label: "Embedding model", value: chunkStatus.models.join(", "), mono: true }]
      : []),
    ...(chunkStatus?.lastEmbeddedAt
      ? [
          {
            label: "Last embedded",
            value: chunkStatus.lastEmbeddedAt.slice(0, 19).replace("T", " "),
            mono: true,
          },
        ]
      : []),
    { label: "Updated", value: doc.updated_at?.slice(0, 19).replace("T", " ") ?? "—", mono: true },
  ];

  return (
    <div className="stack">
      <Section
        title={doc.title}
        description={<ProviderBadge info={provider} />}
        actions={
          <button type="button" className="type-chip" onClick={() => void load()}>
            Refresh
          </button>
        }
      >
        <KeyValue items={items} />

        {pending ? <p className="note">{PENDING_NOTE}</p> : null}
        {doc.status === "error" ? (
          <p className="form-error" role="alert">
            Embedding failed: {doc.error ?? "no error detail recorded"}
          </p>
        ) : null}
      </Section>

      <Section title="Content">
        <pre className="code-pre">{doc.content}</pre>
      </Section>
    </div>
  );
}

export default DocumentDetail;
