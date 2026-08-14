"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import type { ContactList } from "@/lib/contacts/schema";
import { Modal } from "./Modal";

const LINK_BTN: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
};

export interface PushResult {
  attached: number;
  skipped: number;
}

/**
 * Push a MarketingHub contact list into one EmailBison campaign. CSV-backed
 * lists only this round — the API 422s Monday-backed lists, so they're
 * filtered out of the picker with an honest one-line hint. Success closes the
 * dialog through onPushed; the parent reports the result and refetches.
 */
export function PushContactsDialog({
  campaign,
  onClose,
  onPushed,
}: {
  campaign: { id: number; name: string };
  onClose: () => void;
  onPushed: (result: PushResult) => void;
}) {
  const [lists, setLists] = useState<ContactList[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listId, setListId] = useState("");
  const [busy, setBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/contact-lists");
      const body = (await res.json()) as {
        lists?: ContactList[];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      setLists(body.lists ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "load failed");
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const csvLists = (lists ?? []).filter((l) => l.source === "csv");
  const mondayCount = (lists ?? []).length - csvLists.length;

  async function push() {
    setBusy(true);
    setPushError(null);
    try {
      const res = await fetch(`/api/email/campaigns/${campaign.id}/push-list`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactListId: listId }),
      });
      const body = (await res.json().catch(() => null)) as {
        attached?: number;
        skipped?: number;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(body?.error ?? `status ${res.status}`);
      onPushed({ attached: body?.attached ?? 0, skipped: body?.skipped ?? 0 });
    } catch (err) {
      setPushError(err instanceof Error ? err.message : "push failed");
      setBusy(false);
    }
  }

  // A push in flight must finish before the dialog can go away — closing
  // early would skip the parent's refetch and leave the table lying.
  const safeClose = () => {
    if (!busy) onClose();
  };

  return (
    <Modal title={`Push contacts to “${campaign.name}”`} onClose={safeClose}>
      {lists === null && !loadError ? (
        <p className="field-note">Loading lists…</p>
      ) : null}
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}{" "}
          <button
            type="button"
            className="user-menu-signout"
            style={LINK_BTN}
            onClick={() => void loadLists()}
          >
            Retry
          </button>
        </p>
      ) : null}
      {lists !== null ? (
        <div className="field">
          <label htmlFor="push-list">Contact list</label>
          <select
            id="push-list"
            className="control surface"
            value={listId}
            onChange={(e) => setListId(e.target.value)}
          >
            <option value="">Choose a list…</option>
            {csvLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} — {l.contact_count} contacts
              </option>
            ))}
          </select>
          {mondayCount > 0 ? (
            <p className="field-note">
              {"Monday-backed lists aren't pushable yet."}
            </p>
          ) : null}
        </div>
      ) : null}
      {pushError ? (
        <p className="form-error" role="alert">
          {pushError}
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
          disabled={busy || listId === ""}
          onClick={() => void push()}
        >
          {busy ? "Pushing…" : "Push"}
        </button>
      </div>
    </Modal>
  );
}

export default PushContactsDialog;
