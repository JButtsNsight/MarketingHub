"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Guide } from "@/components/guide/Guide";

/**
 * Delete control for a contact list. Two-step confirm (no browser dialogs),
 * and the API refuses (409) when campaigns were built from the list — that
 * message is surfaced verbatim.
 */
export function ListActions({ listId }: { listId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contact-lists/${listId}`, {
        method: "DELETE",
      });
      if (res.status === 204) {
        router.push("/campaigns/lists");
        router.refresh();
        return;
      }
      const body = (await res
        .json()
        .catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Delete failed. Please try again.");
      setConfirming(false);
      setBusy(false);
    } catch {
      setError("Network error — please try again.");
      setConfirming(false);
      setBusy(false);
    }
  };

  return (
    <div className="list-actions">
      <Guide id="campaigns.list-detail.delete">
        <button
          type="button"
          className="type-chip"
          onClick={onDelete}
          disabled={busy}
        >
          {busy ? "Deleting…" : confirming ? "Really delete?" : "Delete list"}
        </button>
      </Guide>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default ListActions;
