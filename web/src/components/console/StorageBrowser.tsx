"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { BucketManager } from "../storage/BucketManager";
import { BucketFormDialog, type BucketRow } from "../storage/BucketFormDialog";
import {
  ResumableUploader,
  type ResumableUploaderHandle,
} from "../storage/ResumableUploader";
import { RESUMABLE_CHUNK_BYTES } from "../storage/resumable";
import {
  TransformPreview,
  isTransformableType,
} from "../storage/TransformPreview";

/**
 * The Storage browser (Studio parity): bucket picker, breadcrumb folder path,
 * upload, rename/move, delete (two-step), download, and transform-aware
 * preview — everything through the group-gated /api/console/storage/* routes,
 * which proxy bytes server-side because the signed URLs point at the private
 * internal data API.
 *
 * Classic uploads never overwrite (the server enforces it) — replacing a file
 * is an explicit delete-then-upload. There is exactly one upload control:
 * files past a single TUS chunk (6MB) route through the resumable uploader
 * automatically (its progress rows appear inline while running), smaller
 * files take the classic POST. The BucketManager section below the listing
 * owns bucket create/edit/empty/delete (the rail's "New bucket" chip opens
 * the same create dialog).
 */

export type { BucketRow } from "../storage/BucketFormDialog";

export interface EntryDto {
  name: string;
  isFolder: boolean;
  size: number | null;
  mimetype: string | null;
  updatedAt: string | null;
  path: string;
}

function formatBytes(bytes: number | null): string {
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

export function StorageBrowser({
  initialBuckets,
  initialBucket,
  initialEntries,
}: {
  initialBuckets: BucketRow[];
  initialBucket: string;
  initialEntries: EntryDto[];
}) {
  const [buckets, setBuckets] = useState(initialBuckets);
  const [bucket, setBucket] = useState(initialBucket);
  const [prefix, setPrefix] = useState("");
  const [entries, setEntries] = useState<EntryDto[]>(initialEntries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [preview, setPreview] = useState<EntryDto | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingBucket, setCreatingBucket] = useState(false);
  const [managerEpoch, setManagerEpoch] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const resumable = useRef<ResumableUploaderHandle>(null);
  const fetchSeq = useRef(0);

  const load = async (nextBucket: string, nextPrefix: string) => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    setPreview(null);
    setArmedDelete(null);
    setRenaming(null);
    try {
      const params = new URLSearchParams({ bucket: nextBucket });
      if (nextPrefix) params.set("prefix", nextPrefix);
      const res = await fetch(`/api/console/storage/objects?${params}`);
      if (seq !== fetchSeq.current) return;
      const body = (await res.json().catch(() => null)) as
        | { entries?: EntryDto[]; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? "Loading the bucket failed.");
        setEntries([]);
        return;
      }
      setEntries(body?.entries ?? []);
    } catch {
      if (seq === fetchSeq.current) setError("Network error — please try again.");
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  };

  // Reload whenever the location changes (bucket switch or folder drill).
  useEffect(() => {
    void load(bucket, prefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, prefix]);

  // Keeps the picker in sync after bucket CRUD; when the current bucket is
  // gone, falls over to the first remaining one at its root.
  const applyBuckets = (next: BucketRow[]) => {
    setBuckets(next);
    if (next.length > 0 && !next.some((b) => b.name === bucket)) {
      setBucket(next[0].name);
      setPrefix("");
    }
  };

  // An emptied bucket still exists, so applyBuckets never moves — the current
  // listing must reload itself or it keeps showing the just-deleted objects.
  // The prefix's pseudo-folders are gone too, so land back at the root.
  const onBucketEmptied = (name: string) => {
    if (name !== bucket) return;
    if (prefix) setPrefix("");
    else void load(bucket, "");
  };

  // For buckets created from the rail dialog: BucketManager owns its own
  // list state, so the fresh fetch also remounts it (key) with the new list.
  const refreshBuckets = async () => {
    try {
      const res = await fetch("/api/console/storage/buckets");
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as
        | { buckets?: BucketRow[] }
        | null;
      if (Array.isArray(body?.buckets)) {
        applyBuckets(body.buckets);
        setManagerEpoch((e) => e + 1);
      }
    } catch {
      // best-effort — the create dialog already reported its own result
    }
  };

  const upload = async (file: File) => {
    setError(null);
    // One Upload button, two transports: anything past a single TUS chunk
    // goes resumable (survives blips, clears the classic 25MB cap) with its
    // progress rows shown inline; small files take the plain POST.
    if (file.size > RESUMABLE_CHUNK_BYTES) {
      resumable.current?.addFiles([file]);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("bucket", bucket);
      form.set("prefix", prefix);
      form.set("file", file);
      const res = await fetch("/api/console/storage/objects", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Upload failed.");
        return;
      }
      void load(bucket, prefix);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (path: string) => {
    setError(null);
    try {
      const res = await fetch("/api/console/storage/objects", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucket, paths: [path] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Delete failed.");
        return;
      }
      void load(bucket, prefix);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setArmedDelete(null);
    }
  };

  const move = async (from: string) => {
    if (!renameTo.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/console/storage/objects", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bucket, from, to: renameTo.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Rename failed.");
        return;
      }
      setRenaming(null);
      void load(bucket, prefix);
    } catch {
      setError("Network error — please try again.");
    }
  };

  const crumbs = [
    { label: bucket, prefix: "" },
    ...((): Array<{ label: string; prefix: string }> => {
      const segments = prefix ? prefix.split("/").filter(Boolean) : [];
      let acc = "";
      return segments.map((seg) => {
        acc = acc ? `${acc}/${seg}` : seg;
        return { label: seg, prefix: acc };
      });
    })(),
  ];

  const columns: Column<EntryDto>[] = [
    {
      key: "name",
      header: "name",
      render: (e) =>
        e.isFolder ? (
          <button
            type="button"
            className="storage-folder"
            onClick={() => setPrefix(e.path)}
          >
            {e.name}/
          </button>
        ) : renaming === e.path ? (
          <span className="campaign-actions">
            <input
              className="surface control teditor-fctl"
              aria-label={`New path for ${e.name}`}
              value={renameTo}
              onChange={(ev) => setRenameTo(ev.target.value)}
            />
            <button type="button" className="type-chip" onClick={() => void move(e.path)}>
              Save
            </button>
            <button type="button" className="type-chip" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="mono">{e.name}</span>
        ),
    },
    {
      key: "type",
      header: "type",
      width: "150px",
      render: (e) => <Badge>{e.isFolder ? "folder" : (e.mimetype ?? "file")}</Badge>,
    },
    {
      key: "size",
      header: "size",
      mono: true,
      align: "right",
      width: "90px",
      render: (e) => (e.isFolder ? "—" : formatBytes(e.size)),
    },
    {
      key: "updated",
      header: "updated",
      mono: true,
      width: "116px",
      render: (e) => (e.updatedAt ? e.updatedAt.slice(0, 10) : "—"),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "280px",
      render: (e) =>
        e.isFolder ? null : (
          <span className="campaign-actions">
            {isTransformableType(e.mimetype) ? (
              <button
                type="button"
                className="type-chip"
                onClick={() => setPreview(preview?.path === e.path ? null : e)}
              >
                {preview?.path === e.path ? "Hide" : "Preview"}
              </button>
            ) : null}
            <a
              className="type-chip"
              href={`/api/console/storage/download?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(e.path)}`}
            >
              Download
            </a>
            <button
              type="button"
              className="type-chip"
              onClick={() => {
                setRenaming(e.path);
                setRenameTo(e.path);
              }}
            >
              Rename
            </button>
            {armedDelete === e.path ? (
              <>
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => void remove(e.path)}
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  className="type-chip"
                  onClick={() => setArmedDelete(null)}
                >
                  Keep
                </button>
              </>
            ) : (
              <button
                type="button"
                className="type-chip"
                onClick={() => setArmedDelete(e.path)}
              >
                Delete
              </button>
            )}
          </span>
        ),
    },
  ];

  return (
    <div className="stack">
      <div className="dgrid-toolbar">
        <select
          className="surface control teditor-fctl"
          aria-label="Bucket"
          value={bucket}
          onChange={(e) => {
            setBucket(e.target.value);
            setPrefix("");
          }}
        >
          {buckets.map((b) => (
            <option key={b.id} value={b.name}>
              {b.name}
              {b.public ? " (public)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="type-chip"
          onClick={() => setCreatingBucket(true)}
        >
          New bucket
        </button>

        {/* A location, not controls: muted path with ancestor links and the
            current segment as plain text. Styles are inline (component-scoped);
            the storage-path class is only a hook for optional theme polish. */}
        <nav
          className="storage-path"
          aria-label="Breadcrumb"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
            fontFamily: "var(--fm)",
            fontSize: "13px",
            color: "var(--muted)",
          }}
        >
          {crumbs.map((c, i) => {
            const current = i === crumbs.length - 1;
            return (
              <span
                key={`${c.prefix}-${i}`}
                style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}
              >
                {i > 0 ? (
                  <span aria-hidden="true" style={{ color: "var(--faint)" }}>
                    /
                  </span>
                ) : null}
                {current ? (
                  <span aria-current="page" style={{ color: "var(--ink)" }}>
                    {c.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPrefix(c.prefix)}
                    style={{
                      background: "none",
                      border: "none",
                      margin: 0,
                      padding: 0,
                      font: "inherit",
                      color: "inherit",
                      cursor: "pointer",
                      textDecoration: "underline",
                      textUnderlineOffset: "3px",
                      textDecorationColor: "var(--faint)",
                    }}
                  >
                    {c.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>

        <span className="spacer" />
        <input
          ref={fileInput}
          type="file"
          className="storage-file-input"
          aria-label="Choose file to upload"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={uploading}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload file"}
        </button>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* TUS through the same-origin proxy — always mounted so in-flight
          uploads survive folder moves, renders nothing while idle. Big files
          from the Upload button land here via the ref. */}
      <ResumableUploader
        ref={resumable}
        bucket={bucket}
        prefix={prefix}
        onUploaded={() => void load(bucket, prefix)}
      />

      {preview ? (
        // Keyed per object so the transform controls reset on selection change.
        <TransformPreview
          key={`${bucket}/${preview.path}`}
          bucket={bucket}
          path={preview.path}
          contentType={preview.mimetype}
        />
      ) : null}

      <div className={loading ? "dgrid-busy" : undefined}>
        <DataTable
          columns={columns}
          rows={entries}
          getRowKey={(e) => e.path}
          empty="This location is empty."
        />
      </div>

      <BucketManager
        key={managerEpoch}
        initialBuckets={buckets}
        onBucketsChanged={applyBuckets}
        onEmptied={onBucketEmptied}
      />

      {creatingBucket ? (
        <BucketFormDialog
          mode="create"
          existingNames={buckets.map((b) => b.name)}
          onClose={(saved) => {
            setCreatingBucket(false);
            if (saved) void refreshBuckets();
          }}
        />
      ) : null}
    </div>
  );
}

export default StorageBrowser;
