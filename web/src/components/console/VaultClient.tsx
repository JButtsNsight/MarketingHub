"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DataTable, type Column } from "@/components/ui/DataTable";
import { Section } from "@/components/ui/Section";
import { useConfirm } from "@/components/ui/AlertDialog";
import type { VaultSecretMeta } from "@/lib/console/vault";

/**
 * The Vault integration screen (supabase_vault parity), MarketingHub-style —
 * and the console's most sensitive surface. The rules this component holds:
 *
 *   - The table lists METADATA ONLY (the list route cannot return values by
 *     construction); every value cell renders masked by default.
 *   - Reveal is per-secret: an interrupting warn confirm, then a POST to the
 *     reveal endpoint (never a GET — a value must never be link-followable,
 *     and it never appears in a URL). The revealed value lives in transient
 *     component state only — auto-masked after REVEAL_TTL_MS, cleared on
 *     Hide, replaced on the next reveal, and gone on unmount. It is never
 *     written to the clipboard, storage, or anywhere else.
 *   - Delete demands the secret's name typed back (its id when unnamed), and
 *     the typed value travels as the route's required `confirm` echo — the
 *     server re-checks it against what the vault actually stores.
 *   - Create/edit go through a local form dialog. Editing REPLACES the stored
 *     value (vault.update_secret re-encrypts); the current value is never
 *     pre-filled — the form cannot know it and must not.
 */

/** Revealed values auto-mask after 30 seconds. */
const REVEAL_TTL_MS = 30_000;

// Mirrors the server-side caps in @/lib/console/vault (a server-only module
// clients cannot import at runtime); the route re-validates, this is UX only.
const NAME_MAX = 256;
const DESCRIPTION_MAX = 2000;
const VALUE_MAX = 8000;

const MASK = "••••••••";

function truncate(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "2026-08-08 02:00:00.123+00" → "2026-08-08 02:00" (metadata timestamps). */
function shortTs(ts: string): string {
  return ts ? ts.slice(0, 16) : "—";
}

/** A secret's human handle: its name, or its id when unnamed. */
function labelOf(secret: VaultSecretMeta): string {
  return secret.name ?? secret.id;
}

/**
 * The type-to-confirm input embedded in the delete confirm modal's message.
 * The dialog stores the message node once, so this owns its input state and
 * reports the latest value through a ref the caller reads after confirm.
 * (Same pattern as the storage BucketManager — the shared AlertDialog itself
 * is untouched.)
 */
function ConfirmNameField({
  expected,
  valueRef,
}: {
  expected: string;
  valueRef: { current: string };
}) {
  const [value, setValue] = useState("");
  return (
    <span className="field" style={{ display: "flex", marginTop: 10 }}>
      <label htmlFor="confirm-secret-name">
        Type <span className="mono">{expected}</span> to confirm
      </label>
      <input
        id="confirm-secret-name"
        className="surface control mono"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          valueRef.current = e.target.value;
        }}
      />
    </span>
  );
}

/**
 * Create/edit dialog, local to the vault surface. The value input is a
 * password field (masked while typing, kept out of autofill); its state lives
 * only in this component and unmounts with it when the dialog closes.
 */
function SecretFormDialog({
  secret,
  onClose,
}: {
  /** null = create; a secret = edit (value replaced, never pre-filled). */
  secret: VaultSecretMeta | null;
  onClose: (saved: boolean) => void;
}) {
  const editing = secret;
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape cancels, like the alert dialog; a backdrop click does too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!value) {
      setError(
        editing
          ? "A new value is required — saving re-encrypts and replaces the stored value."
          : "Value is required.",
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        editing
          ? `/api/console/vault/${encodeURIComponent(editing.id)}`
          : "/api/console/vault",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmedName, description, value }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          body?.error ??
            (editing ? "Updating the secret failed." : "Creating the secret failed."),
        );
        return;
      }
      onClose(true);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="alert-backdrop"
      onClick={() => onClose(false)}
      data-testid="vault-dialog-backdrop"
    >
      <div
        className="surface alert-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="vault-dialog-title" className="alert-title">
          {editing ? `Edit secret "${labelOf(editing)}"` : "New secret"}
        </h2>

        <div className="field">
          <label htmlFor="secret-name">Name</label>
          <input
            id="secret-name"
            className="surface control mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={NAME_MAX}
            autoFocus={editing == null}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-note">
            Unique handle for lookups (vault.secrets.name).
          </p>
        </div>

        <div className="field">
          <label htmlFor="secret-description">Description</label>
          <input
            id="secret-description"
            className="surface control"
            type="text"
            autoComplete="off"
            maxLength={DESCRIPTION_MAX}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="field-note">
            Optional — what this secret is for. Shown in the metadata list.
          </p>
        </div>

        <div className="field">
          <label htmlFor="secret-value">Value</label>
          <input
            id="secret-value"
            className="surface control mono"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            maxLength={VALUE_MAX}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <p className="field-note">
            {editing
              ? "The current value is never shown here. Saving re-encrypts and REPLACES it with what you type."
              : "Encrypted at rest by supabase_vault. Shown again only through an audited per-secret reveal."}
          </p>
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
            onClick={() => onClose(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {editing ? "Save changes" : "Create secret"}
          </button>
        </div>
      </div>
    </div>
  );
}

type DialogState = { mode: "create" } | { mode: "edit"; secret: VaultSecretMeta };

export function VaultClient({
  initialSecrets,
}: {
  initialSecrets: VaultSecretMeta[];
}) {
  const [secrets, setSecrets] = useState(initialSecrets);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  // TRANSIENT plaintext state — at most one secret at a time, auto-masked by
  // the TTL timer, and destroyed with the component. It exists nowhere else.
  const [revealed, setRevealed] = useState<{ id: string; value: string } | null>(
    null,
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, dialog } = useConfirm();
  const confirmName = useRef("");

  const hideRevealed = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setRevealed(null);
  }, []);

  // Unmount: stop the timer; the revealed value dies with component state.
  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/console/vault");
      const body = (await res.json().catch(() => null)) as
        | { secrets?: VaultSecretMeta[]; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Loading the secret list failed.");
        return;
      }
      setSecrets(body?.secrets ?? []);
      setError(null);
    } catch {
      setError("Network error — please try again.");
    }
  }, []);

  const onReveal = async (secret: VaultSecretMeta) => {
    const label = labelOf(secret);
    // Per-secret interrupt before the ONLY plaintext round-trip.
    const ok = await confirm({
      title: `Reveal "${truncate(label, 48)}"?`,
      // "is recorded" is a GUARANTEE, not an aspiration: the reveal route
      // writes the audit row before decrypting and refuses the reveal when
      // the audit log cannot be written (fail-closed).
      message:
        "The decrypted value will be fetched and shown on this screen until you hide it (it auto-masks after 30 seconds). The reveal is recorded in the vault audit log with your identity before the value is fetched — if the audit log cannot be written, the reveal is refused.",
      confirmLabel: "Reveal secret",
      tone: "warn",
    });
    if (!ok) return;

    hideRevealed();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/console/vault/${encodeURIComponent(secret.id)}/reveal`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => null)) as
        | { value?: string; error?: string }
        | null;
      if (!res.ok || typeof body?.value !== "string") {
        setError(body?.error ?? "Revealing the secret failed.");
        return;
      }
      setRevealed({ id: secret.id, value: body.value });
      hideTimer.current = setTimeout(() => {
        hideTimer.current = null;
        setRevealed(null);
      }, REVEAL_TTL_MS);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (secret: VaultSecretMeta) => {
    const expected = labelOf(secret);
    confirmName.current = "";
    const ok = await confirm({
      title: `Delete "${truncate(expected, 48)}"?`,
      message: (
        <span style={{ display: "block" }}>
          Permanently delete this secret. The encrypted value is unrecoverable
          once the row is gone. This cannot be undone.
          <ConfirmNameField expected={expected} valueRef={confirmName} />
        </span>
      ),
      confirmLabel: "Delete secret",
      tone: "warn",
    });
    if (!ok) return;
    // EXACT match, no trimming — the server compares the confirm echo against
    // server truth verbatim (vault/[id]/route.ts), and names created outside
    // the console (SQL editor, direct vault.create_secret) can legitimately
    // carry edge whitespace; trimming here would make such secrets
    // console-undeletable even when the user types the name perfectly.
    const typed = confirmName.current;
    if (typed !== expected) {
      setError(`Secret name did not match — "${expected}" was not deleted.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/console/vault/${encodeURIComponent(secret.id)}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: typed }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(body?.error ?? "Deleting the secret failed.");
        return;
      }
      if (revealed?.id === secret.id) hideRevealed();
      await refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<VaultSecretMeta>[] = [
    {
      key: "name",
      header: "name",
      mono: true,
      render: (s) =>
        s.name !== null ? (
          <span title={s.name}>{truncate(s.name, 40)}</span>
        ) : (
          <span title={s.id}>{`${s.id.slice(0, 8)}… (unnamed)`}</span>
        ),
    },
    {
      key: "description",
      header: "description",
      render: (s) =>
        s.description ? (
          <span title={s.description}>{truncate(s.description, 56)}</span>
        ) : (
          "—"
        ),
    },
    {
      key: "value",
      header: "value",
      width: "260px",
      render: (s) =>
        revealed !== null && revealed.id === s.id ? (
          <span className="campaign-actions">
            <span className="mono" data-testid={`revealed-${s.id}`}>
              {revealed.value}
            </span>
            <button type="button" className="type-chip" onClick={hideRevealed}>
              Hide
            </button>
          </span>
        ) : (
          <span className="campaign-actions">
            {/* masked placeholder — the list never holds a value to show */}
            <span className="mono" aria-label="value hidden">
              {MASK}
            </span>
            <button
              type="button"
              className="type-chip"
              disabled={busy}
              onClick={() => void onReveal(s)}
            >
              Reveal…
            </button>
          </span>
        ),
    },
    {
      key: "createdAt",
      header: "created",
      mono: true,
      width: "150px",
      render: (s) => shortTs(s.createdAt),
    },
    {
      key: "updatedAt",
      header: "updated",
      mono: true,
      width: "150px",
      render: (s) => shortTs(s.updatedAt),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "160px",
      render: (s) => (
        <span className="campaign-actions">
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => setDialogState({ mode: "edit", secret: s })}
          >
            Edit
          </button>
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => void onDelete(s)}
          >
            Delete…
          </button>
        </span>
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

      <Section
        eyebrow="supabase_vault"
        title="Secrets"
        description="Encrypted at rest inside Postgres. This list is metadata only — values are decrypted one at a time through the audited reveal, never in a listing."
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setDialogState({ mode: "create" })}
          >
            New secret
          </button>
        }
      >
        <div className={busy ? "dgrid-busy" : undefined}>
          <DataTable
            columns={columns}
            rows={secrets}
            getRowKey={(s) => s.id}
            empty="No secrets stored — create one."
          />
        </div>
      </Section>

      {dialogState ? (
        <SecretFormDialog
          secret={dialogState.mode === "edit" ? dialogState.secret : null}
          onClose={(saved) => {
            setDialogState(null);
            if (saved) void refresh();
          }}
        />
      ) : null}
      {dialog}
    </div>
  );
}

export default VaultClient;
