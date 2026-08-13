"use client";

// Paste-text ingestion — the ONLY ingestion path this wave (URL fetching is
// deferred pending SSRF guardrails). Validates with the shared zod schema and
// POSTs /api/intel/documents; the DB trigger enqueues the embedding job, so
// on success the caller reloads and the new document shows an honest
// "pending" status until the worker drains the queue.

import { useState } from "react";
import { DocumentCreateInputSchema } from "@/lib/intel/schema";
import { Guide } from "@/components/guide/Guide";
import { Surface } from "../Surface";
import { createDocument, IntelApiError } from "./api";

export function AddDocumentForm({
  sourceId,
  onAdded,
}: {
  sourceId: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const parsed = DocumentCreateInputSchema.safeParse({ sourceId, title, content });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await createDocument(parsed.data);
      setBusy(false);
      setOpen(false);
      setTitle("");
      setContent("");
      onAdded();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof IntelApiError ? err.message : "Adding the document failed.",
      );
    }
  };

  if (!open) {
    return (
      <Guide id="intel.add-doc.open">
        <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
          Paste a document
        </button>
      </Guide>
    );
  }

  return (
    <Surface className="reschedule-pop" elevated={false}>
      <Guide id="intel.add-doc.title">
        <div className="field">
          <label htmlFor="doc-title">Title</label>
          <input
            id="doc-title"
            type="text"
            className="surface control"
            placeholder="e.g. Pricing page — August snapshot"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      </Guide>
      <Guide id="intel.add-doc.content">
        <div className="field">
          <label htmlFor="doc-content">Content (paste text)</label>
          <textarea
            id="doc-content"
            className="surface control"
            rows={10}
            placeholder="Paste the competitor content here — headings and paragraphs are preserved for chunking."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
      </Guide>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Guide id="intel.add-doc.cancel">
          <button
            type="button"
            className="type-chip"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            disabled={busy}
          >
            Cancel
          </button>
        </Guide>
        <Guide id="intel.add-doc.submit">
          <button type="button" className="btn-primary" onClick={onSubmit} disabled={busy}>
            {busy ? "Adding…" : "Add document"}
          </button>
        </Guide>
      </div>
    </Surface>
  );
}

export default AddDocumentForm;
