"use client";

import { useEffect, useState } from "react";

/**
 * Studio-parity bucket create/edit dialog. Name is immutable after creation
 * (the Storage API has no rename), the Public toggle spells out exactly what
 * public means, the size limit is entered value+unit, and the MIME allow-list
 * is comma-separated. Everything goes through the group-gated
 * /api/console/storage/buckets route — the browser never reaches Supabase.
 *
 * On update the route requires `public` explicitly (the Storage API replaces
 * visibility on every update), so the dialog always sends the full settings
 * object: fileSizeLimit/allowedMimeTypes are `null` when cleared, never
 * omitted, making an edit an exact replace of what the form shows.
 */

/** One bucket as the buckets route serializes it (lib StorageBucket). */
export interface BucketRow {
  id: string;
  name: string;
  public: boolean;
  createdAt: string | null;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
}

// Mirrors the server-side rules in @/lib/console/storage (a server-only
// module clients cannot import); the route re-validates, this is UX only.
const SAFE_BUCKET = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SAFE_MIME = /^[a-z0-9!#$&^_.+-]+\/(\*|[a-z0-9!#$&^_.+-]+)$/i;
const SIZE_LIMIT_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const MIME_LIST_MAX = 64;

const UNITS = [
  { id: "B", label: "bytes", bytes: 1 },
  { id: "KB", label: "KB", bytes: 1024 },
  { id: "MB", label: "MB", bytes: 1024 * 1024 },
  { id: "GB", label: "GB", bytes: 1024 * 1024 * 1024 },
] as const;

type UnitId = (typeof UNITS)[number]["id"];

/** Largest unit that divides the stored byte limit evenly — clean prefill. */
function splitLimit(limit: number | null): { value: string; unit: UnitId } {
  if (limit == null) return { value: "", unit: "MB" };
  for (let i = UNITS.length - 1; i >= 0; i -= 1) {
    if (limit % UNITS[i].bytes === 0) {
      return { value: String(limit / UNITS[i].bytes), unit: UNITS[i].id };
    }
  }
  return { value: String(limit), unit: "B" };
}

export type BucketFormDialogProps =
  | {
      mode: "create";
      /** Existing bucket names, for a duplicate check before the POST. */
      existingNames?: string[];
      onClose: (saved: boolean) => void;
    }
  | {
      mode: "edit";
      bucket: BucketRow;
      onClose: (saved: boolean) => void;
    };

export function BucketFormDialog(props: BucketFormDialogProps) {
  const { onClose } = props;
  const editing = props.mode === "edit" ? props.bucket : null;
  const initialLimit = splitLimit(editing?.fileSizeLimit ?? null);

  const [name, setName] = useState(editing?.name ?? "");
  const [isPublic, setIsPublic] = useState(editing?.public ?? false);
  const [sizeValue, setSizeValue] = useState(initialLimit.value);
  const [sizeUnit, setSizeUnit] = useState<UnitId>(initialLimit.unit);
  const [mimeText, setMimeText] = useState(
    editing?.allowedMimeTypes?.join(", ") ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => onClose(false);

  // Escape cancels, like the alert dialog; a backdrop click does too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Validate the form; returns the request body or null (error state set). */
  const buildBody = (): {
    name: string;
    public: boolean;
    fileSizeLimit: number | null;
    allowedMimeTypes: string[] | null;
  } | null => {
    const bucketName = editing ? editing.name : name.trim();
    if (!SAFE_BUCKET.test(bucketName) || bucketName.includes("..")) {
      setError(
        "Bucket names are 1-100 letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
      );
      return null;
    }
    if (props.mode === "create" && props.existingNames?.includes(bucketName)) {
      setError(`A bucket named "${bucketName}" already exists.`);
      return null;
    }

    let fileSizeLimit: number | null = null;
    if (sizeValue.trim() !== "") {
      const unit = UNITS.find((u) => u.id === sizeUnit) ?? UNITS[0];
      const bytes = Number(sizeValue) * unit.bytes;
      if (
        !Number.isFinite(bytes) ||
        !Number.isInteger(bytes) ||
        bytes < 1 ||
        bytes > SIZE_LIMIT_MAX_BYTES
      ) {
        setError(
          "File size limit must be a whole number of bytes between 1 and 50 GB.",
        );
        return null;
      }
      fileSizeLimit = bytes;
    }

    let allowedMimeTypes: string[] | null = null;
    const mimes = mimeText
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter(Boolean);
    if (mimes.length > 0) {
      if (mimes.length > MIME_LIST_MAX) {
        setError(`At most ${MIME_LIST_MAX} MIME types are allowed.`);
        return null;
      }
      const bad = mimes.find((m) => m.length > 255 || !SAFE_MIME.test(m));
      if (bad !== undefined) {
        setError(
          `"${bad}" is not a valid MIME type — use type/subtype or type/* (e.g. image/png, image/*).`,
        );
        return null;
      }
      allowedMimeTypes = mimes;
    }

    return { name: bucketName, public: isPublic, fileSizeLimit, allowedMimeTypes };
  };

  const submit = async () => {
    setError(null);
    const body = buildBody();
    if (!body) return;
    setBusy(true);
    try {
      const res = await fetch("/api/console/storage/buckets", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          payload?.error ??
            (editing ? "Updating the bucket failed." : "Creating the bucket failed."),
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
      onClick={cancel}
      data-testid="bucket-dialog-backdrop"
    >
      <div
        className="surface alert-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bucket-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="bucket-dialog-title" className="alert-title">
          {editing ? `Edit bucket "${editing.name}"` : "New bucket"}
        </h2>

        <div className="field">
          <label htmlFor="bucket-name">Bucket name</label>
          <input
            id="bucket-name"
            className="surface control mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={editing ? editing.name : name}
            disabled={editing != null}
            autoFocus={editing == null}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="field-note">
            {editing
              ? "Bucket names are immutable — the Storage API has no rename."
              : "Immutable after creation. Letters, digits, dots, dashes, underscores."}
          </p>
        </div>

        <div className="field">
          <label htmlFor="bucket-public">
            <input
              id="bucket-public"
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />{" "}
            Public bucket
          </label>
          {isPublic ? (
            <p
              className="field-note"
              role="note"
              style={{ color: "var(--warn)" }}
            >
              Public means anyone with an object&apos;s URL can read it — no
              sign-in, no signed URL, no expiry. Only make a bucket public when
              every file in it is meant for the open internet.
            </p>
          ) : (
            <p className="field-note">
              Private — objects are only reachable through signed URLs.
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="bucket-size-limit">File size limit</label>
          <div className="field-row">
            <input
              id="bucket-size-limit"
              className="surface control mono"
              type="number"
              min="0"
              step="any"
              placeholder="no per-bucket limit"
              value={sizeValue}
              onChange={(e) => setSizeValue(e.target.value)}
            />
            <select
              className="surface control"
              aria-label="Unit"
              value={sizeUnit}
              onChange={(e) => setSizeUnit(e.target.value as UnitId)}
            >
              {UNITS.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </div>
          <p className="field-note">
            Per-object cap for this bucket. Leave empty for none — the
            server&apos;s global limit always applies.
          </p>
        </div>

        <div className="field">
          <label htmlFor="bucket-mime-types">Allowed MIME types</label>
          <input
            id="bucket-mime-types"
            className="surface control mono"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="image/png, image/*"
            value={mimeText}
            onChange={(e) => setMimeText(e.target.value)}
          />
          <p className="field-note">
            Comma-separated; wildcards like image/* work. Leave empty to accept
            every type.
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
            onClick={cancel}
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
            {editing ? "Save changes" : "Create bucket"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BucketFormDialog;
