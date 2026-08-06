"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Surface } from "../Surface";

/**
 * Manual STOP-list entry. Collapsed to a button; expanded it POSTs the
 * group-gated suppressions route (the server normalizes to E.164, sweeps the
 * phone's not-yet-attempted outbox rows, and writes the audit row) and
 * refreshes the server page. A 409 means the phone was already suppressed —
 * said explicitly, since the operator's goal is already met.
 */
export function AddSuppressionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async () => {
    if (!phone.trim()) {
      setError("Enter a phone number.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/suppressions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: phone.trim(),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      if (res.status === 409) {
        setError("That number is already on the suppression list.");
        setBusy(false);
        return;
      }
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Adding the number failed. Please try again.");
        setBusy(false);
        return;
      }
      setBusy(false);
      setOpen(false);
      setPhone("");
      setNote("");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        className="btn-primary"
        onClick={() => setOpen(true)}
      >
        Suppress a number
      </button>
    );
  }

  return (
    <Surface className="reschedule-pop" elevated={false}>
      <div className="field">
        <label htmlFor="suppress-phone">Phone (US)</label>
        <input
          id="suppress-phone"
          type="tel"
          className="surface control"
          placeholder="(555) 555-0100"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="suppress-note">Why (kept in the audit trail)</label>
        <input
          id="suppress-note"
          type="text"
          className="surface control"
          placeholder="e.g. asked to stop by phone"
          value={note}
          onChange={(e) => setNote(e.target.value)}
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
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={onAdd}
          disabled={busy}
        >
          Suppress
        </button>
      </div>
    </Surface>
  );
}

export default AddSuppressionForm;
