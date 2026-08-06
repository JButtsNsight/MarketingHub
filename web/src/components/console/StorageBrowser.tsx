"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";
import { Surface } from "../Surface";

/**
 * The Storage browser (Studio parity): bucket picker, breadcrumb folder tree,
 * upload, rename/move, delete (two-step), download, and inline preview for
 * images — everything through the group-gated /api/console/storage/* routes,
 * which proxy bytes server-side because the signed URLs point at the private
 * internal data API.
 *
 * Uploads never overwrite (the server enforces it) — replacing a file is an
 * explicit delete-then-upload.
 */

export interface BucketDto {
  id: string;
  name: string;
  public: boolean;
}

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

const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/;

export function StorageBrowser({
  initialBuckets,
  initialBucket,
  initialEntries,
}: {
  initialBuckets: BucketDto[];
  initialBucket: string;
  initialEntries: EntryDto[];
}) {
  const [buckets] = useState(initialBuckets);
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
  const fileInput = useRef<HTMLInputElement>(null);
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

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
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
            {e.mimetype && PREVIEWABLE.test(e.mimetype) ? (
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

        <nav className="tabs storage-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <button
              key={`${c.prefix}-${i}`}
              type="button"
              className={i === crumbs.length - 1 ? "tab on" : "tab"}
              onClick={() => setPrefix(c.prefix)}
            >
              {c.label}
            </button>
          ))}
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

      {preview ? (
        <Surface className="storage-preview" glint>
          <span className="eyebrow">{preview.path}</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/console/storage/download?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(preview.path)}&inline=1`}
            alt={preview.name}
          />
        </Surface>
      ) : null}

      <div className={loading ? "dgrid-busy" : undefined}>
        <DataTable
          columns={columns}
          rows={entries}
          getRowKey={(e) => e.path}
          empty="This location is empty."
        />
      </div>
    </div>
  );
}

export default StorageBrowser;
