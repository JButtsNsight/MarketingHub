"use client";

import { useState } from "react";
import { Modal } from "./Modal";

/** Mirrors the server gate in /api/email/campaigns/create. */
const NAME_MAX = 200;

/**
 * Name-only campaign create. EmailBison's contract: new campaigns are
 * outbound and born in Draft — sequence, schedule, and sender emails are
 * finished in EmailBison, so the parent's success line links out.
 */
export function NewCampaignDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (campaign: { id: number; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/email/campaigns/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = (await res.json().catch(() => null)) as {
        id?: number;
        name?: string;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`);
      onCreated({ id: body?.id ?? 0, name: body?.name ?? name.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
      setBusy(false);
    }
  }

  // A create in flight must finish before the dialog can go away — closing
  // early would skip the parent's refetch and success line.
  const safeClose = () => {
    if (!busy) onClose();
  };

  return (
    <Modal title="New campaign" onClose={safeClose}>
      <div className="field">
        <label htmlFor="nc-name">Campaign name</label>
        <input
          id="nc-name"
          className="control surface"
          value={name}
          maxLength={NAME_MAX}
          placeholder="e.g. Q4 outreach"
          onChange={(e) => setName(e.target.value)}
        />
        <p className="field-note">
          Created as a Draft — sequence and schedule live in EmailBison.
        </p>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="alert-actions">
        <button
          type="button"
          className="type-chip"
          onClick={safeClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || name.trim() === ""}
          onClick={() => void create()}
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

export default NewCampaignDialog;
