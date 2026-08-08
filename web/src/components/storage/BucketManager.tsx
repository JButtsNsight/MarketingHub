"use client";

import { useCallback, useRef, useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Section } from "../ui/Section";
import { useConfirm } from "../ui/AlertDialog";
import { BucketFormDialog, type BucketRow } from "./BucketFormDialog";

/**
 * Bucket management (Studio parity): create/edit through the settings dialog,
 * plus empty-bucket and delete-bucket behind the confirm modal — BOTH demand
 * the bucket name typed back before anything is sent, and the typed value is
 * what travels as the route's required `confirm` echo. Emptying mass-deletes
 * every object, so it gets the same gate as delete.
 *
 * All traffic goes through the group-gated /api/console/storage/buckets
 * route. After every mutation the list is re-fetched and `onBucketsChanged`
 * fires so a composed browser (bucket picker) can stay in sync; a successful
 * empty additionally fires `onEmptied` — the bucket still exists, so the
 * bucket-list refresh alone cannot tell the browser its listing is stale.
 */

export type { BucketRow } from "./BucketFormDialog";

function formatLimit(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The type-to-confirm input embedded in the confirm modal's message. The
 * dialog stores the message node once, so this must own its input state and
 * report the latest value through a ref the caller reads after confirm.
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
      <label htmlFor="confirm-bucket-name">
        Type <span className="mono">{expected}</span> to confirm
      </label>
      <input
        id="confirm-bucket-name"
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

type DialogState = { mode: "create" } | { mode: "edit"; bucket: BucketRow };

export function BucketManager({
  initialBuckets,
  onBucketsChanged,
  onEmptied,
}: {
  initialBuckets: BucketRow[];
  onBucketsChanged?: (buckets: BucketRow[]) => void;
  onEmptied?: (name: string) => void;
}) {
  const [buckets, setBuckets] = useState(initialBuckets);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const { confirm, dialog } = useConfirm();
  const confirmName = useRef("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/console/storage/buckets");
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as
        | { buckets?: BucketRow[] }
        | null;
      if (Array.isArray(body?.buckets)) {
        setBuckets(body.buckets);
        onBucketsChanged?.(body.buckets);
      }
    } catch {
      // refresh is best-effort; the mutations own the error surface
    }
  }, [onBucketsChanged]);

  const destroy = useCallback(
    async (
      name: string,
      action: "delete" | "empty",
      confirmValue: string,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/console/storage/buckets", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, action, confirm: confirmValue }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(body?.error ?? "The action failed.");
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError("Network error — please try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const onEmpty = async (bucket: BucketRow) => {
    confirmName.current = "";
    const ok = await confirm({
      title: `Empty "${bucket.name}"?`,
      message: (
        <span style={{ display: "block" }}>
          Permanently delete every object in &quot;{bucket.name}&quot;. The
          bucket itself remains. This cannot be undone.
          <ConfirmNameField expected={bucket.name} valueRef={confirmName} />
        </span>
      ),
      confirmLabel: "Empty bucket",
    });
    if (!ok) return;
    const typed = confirmName.current.trim();
    if (typed !== bucket.name) {
      setError(`Bucket name did not match — "${bucket.name}" was not emptied.`);
      return;
    }
    if (await destroy(bucket.name, "empty", typed)) onEmptied?.(bucket.name);
  };

  const onDelete = async (bucket: BucketRow) => {
    confirmName.current = "";
    const ok = await confirm({
      title: `Delete "${bucket.name}"?`,
      message: (
        <span style={{ display: "block" }}>
          Permanently delete the bucket &quot;{bucket.name}&quot;. This cannot
          be undone. The Storage API refuses to delete a bucket that still
          holds objects — empty it first.
          <ConfirmNameField expected={bucket.name} valueRef={confirmName} />
        </span>
      ),
      confirmLabel: "Delete bucket",
    });
    if (!ok) return;
    const typed = confirmName.current.trim();
    if (typed !== bucket.name) {
      setError(
        `Bucket name did not match — "${bucket.name}" was not deleted.`,
      );
      return;
    }
    await destroy(bucket.name, "delete", typed);
  };

  const columns: Column<BucketRow>[] = [
    { key: "name", header: "bucket", mono: true },
    {
      key: "visibility",
      header: "visibility",
      width: "110px",
      render: (b) =>
        b.public ? <Badge tone="var(--warn)">public</Badge> : <Badge>private</Badge>,
    },
    {
      key: "fileSizeLimit",
      header: "size limit",
      mono: true,
      align: "right",
      width: "110px",
      render: (b) => formatLimit(b.fileSizeLimit),
    },
    {
      key: "allowedMimeTypes",
      header: "allowed types",
      render: (b) => {
        if (!b.allowedMimeTypes || b.allowedMimeTypes.length === 0) return "any";
        const text = b.allowedMimeTypes.join(", ");
        return (
          <span className="mono" title={text}>
            {text.length > 42 ? `${text.slice(0, 41)}…` : text}
          </span>
        );
      },
    },
    {
      key: "createdAt",
      header: "created",
      mono: true,
      width: "116px",
      render: (b) => (b.createdAt ? b.createdAt.slice(0, 10) : "—"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "220px",
      render: (b) => (
        <span className="campaign-actions">
          <button
            type="button"
            className="type-chip"
            onClick={() => setDialogState({ mode: "edit", bucket: b })}
          >
            Edit
          </button>
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => void onEmpty(b)}
          >
            Empty
          </button>
          <button
            type="button"
            className="type-chip"
            disabled={busy}
            onClick={() => void onDelete(b)}
          >
            Delete…
          </button>
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <Section
        eyebrow="storage"
        title="Buckets"
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() => setDialogState({ mode: "create" })}
          >
            New bucket
          </button>
        }
      >
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className={busy ? "dgrid-busy" : undefined}>
          <DataTable
            columns={columns}
            rows={buckets}
            getRowKey={(b) => b.id}
            empty="No buckets yet — create one."
          />
        </div>
      </Section>

      {dialogState ? (
        dialogState.mode === "edit" ? (
          <BucketFormDialog
            mode="edit"
            bucket={dialogState.bucket}
            onClose={(saved) => {
              setDialogState(null);
              if (saved) void refresh();
            }}
          />
        ) : (
          <BucketFormDialog
            mode="create"
            existingNames={buckets.map((b) => b.name)}
            onClose={(saved) => {
              setDialogState(null);
              if (saved) void refresh();
            }}
          />
        )
      ) : null}
      {dialog}
    </div>
  );
}

export default BucketManager;
