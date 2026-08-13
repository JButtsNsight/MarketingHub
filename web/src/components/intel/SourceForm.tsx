"use client";

// Create/edit form for a competitor-intel source. Validates client-side with
// the SAME zod schemas the API routes use (lib/intel/schema is pure), so the
// first error a user sees matches what the server would say. `kind: url`
// stores the URL as reference metadata only — fetching is honestly deferred
// (SSRF guardrails pending) and labeled as such right on the field.

import { useState } from "react";
import {
  SOURCE_KINDS,
  SourceCreateInputSchema,
  SourceUpdateInputSchema,
  type SourceKind,
} from "@/lib/intel/schema";
import { Guide } from "@/components/guide/Guide";
import { Surface } from "../Surface";
import { createSource, updateSource, IntelApiError } from "./api";
import { URL_FETCH_NOTE } from "./status";
import type { IntelSourceSummary } from "./types";

export function SourceForm({
  initial,
  onSaved,
  onCancel,
}: {
  /** When present, the form edits this source; otherwise it creates one. */
  initial?: IntelSourceSummary;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<SourceKind>(initial?.kind ?? "text");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const raw = { name, kind, url: url.trim() || null, notes: notes.trim() || null };
    const schema = initial ? SourceUpdateInputSchema : SourceCreateInputSchema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (initial) await updateSource(initial.id, parsed.data);
      else await createSource(parsed.data);
      onSaved();
    } catch (err) {
      setError(
        err instanceof IntelApiError ? err.message : "Saving failed. Please try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Surface className="reschedule-pop" elevated={false}>
      <Guide id="intel.source-form.name">
        <div className="field">
          <label htmlFor="source-name">Name</label>
          <input
            id="source-name"
            type="text"
            className="surface control"
            placeholder="e.g. Acme Health pricing page"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </Guide>
      <Guide id="intel.source-form.kind">
        <div className="field">
          <label htmlFor="source-kind">Kind</label>
          <select
            id="source-kind"
            className="surface control"
            value={kind}
            onChange={(e) => setKind(e.target.value as SourceKind)}
          >
            {SOURCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      </Guide>
      <Guide id="intel.source-form.url">
        <div className="field">
          <label htmlFor="source-url">URL (reference only)</label>
          <input
            id="source-url"
            type="url"
            className="surface control"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="field-note">{URL_FETCH_NOTE}</p>
        </div>
      </Guide>
      <Guide id="intel.source-form.notes">
        <div className="field">
          <label htmlFor="source-notes">Notes</label>
          <input
            id="source-notes"
            type="text"
            className="surface control"
            placeholder="context for the team"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </Guide>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Guide id="intel.source-form.cancel">
          <button type="button" className="type-chip" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </Guide>
        <Guide id="intel.source-form.save">
          <button type="button" className="btn-primary" onClick={onSubmit} disabled={busy}>
            {busy ? "Saving…" : initial ? "Save changes" : "Create source"}
          </button>
        </Guide>
      </div>
    </Surface>
  );
}

export default SourceForm;
