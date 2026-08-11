"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import Uppy, { type Body, type Meta, type UppyFile } from "@uppy/core";
import Tus from "@uppy/tus";

import { Badge } from "../ui/Badge";
import { Surface } from "../Surface";
import {
  RESUMABLE_CHUNK_BYTES,
  RESUMABLE_ENDPOINT,
  RESUMABLE_MAX_BYTES,
  RESUMABLE_RETRY_DELAYS,
  buildObjectName,
  formatBytes,
} from "./resumable";

/**
 * Resumable (TUS) uploads for the Storage console. Files go through the
 * group-gated /api/console/storage/tus proxy — the browser never reaches
 * Supabase directly. Uploads survive pause/resume and transient network
 * failures (6MB chunks, retry backoff); files above the 1 GiB proxy cap are
 * refused before any bytes move.
 *
 * There is no picker of its own: the owner pushes files in through the
 * `ref` handle's `addFiles` (StorageBrowser routes anything past one TUS
 * chunk here automatically), and the component renders nothing while idle —
 * progress rows and rejections appear inline only while uploads are queued.
 *
 * Uploads never overwrite unless the caller opts in via `allowOverwrite`
 * (mirror of the classic path's upsert:false).
 */

/** Upload-Metadata keys the TUS proxy forwards to the storage API. */
interface ResumableMeta extends Record<string, unknown> {
  bucketName?: string;
  objectName?: string;
  contentType?: string;
  cacheControl?: string;
}

type ResumableFile = UppyFile<ResumableMeta, Body>;

export type ResumableStatus = "queued" | "uploading" | "paused" | "error" | "done";

export interface ResumableRow {
  id: string;
  objectName: string;
  size: number | null;
  bytesUploaded: number;
  percent: number;
  status: ResumableStatus;
  error: string | null;
}

interface Rejection {
  name: string;
  reason: string;
}

/** Imperative surface the owning view uses to queue files for TUS upload. */
export interface ResumableUploaderHandle {
  /** Queue files — uploads start immediately (autoProceed). */
  addFiles: (files: ArrayLike<File>) => void;
}

export interface ResumableUploaderProps {
  /** Bucket new files upload into (in-flight files keep the bucket they started with). */
  bucket: string;
  /** Folder prefix for new files — "" is the bucket root. */
  prefix?: string;
  /** Send x-upsert so uploads may replace existing objects. Default: never overwrite. */
  allowOverwrite?: boolean;
  /** Fires per completed file with the final object key — refresh listings here. */
  onUploaded?: (objectName: string) => void;
  /** Handle for pushing files in — the component has no file picker of its own. */
  ref?: Ref<ResumableUploaderHandle>;
}

function toRow(file: ResumableFile): ResumableRow {
  const progress = file.progress;
  const bytesUploaded =
    typeof progress.bytesUploaded === "number" ? progress.bytesUploaded : 0;
  const total = progress.bytesTotal ?? file.size;
  const percent = progress.uploadComplete
    ? 100
    : total && total > 0
      ? Math.min(100, Math.floor((bytesUploaded / total) * 100))
      : 0;
  const status: ResumableStatus = file.error
    ? "error"
    : progress.uploadComplete
      ? "done"
      : file.isPaused
        ? "paused"
        : progress.uploadStarted != null
          ? "uploading"
          : "queued";
  return {
    id: file.id,
    objectName: file.meta.objectName ?? file.name,
    size: file.size,
    bytesUploaded,
    percent,
    status,
    error: file.error ?? null,
  };
}

const STATUS_TONE: Partial<Record<ResumableStatus, string>> = {
  done: "var(--ok)",
  error: "var(--fail)",
  paused: "var(--warn)",
};

export function ResumableUploader({
  bucket,
  prefix = "",
  allowOverwrite = false,
  onUploaded,
  ref,
}: ResumableUploaderProps) {
  const uppyRef = useRef<Uppy<ResumableMeta, Body> | null>(null);
  const [rows, setRows] = useState<ResumableRow[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);

  // Handlers are bound once per mount — they read the latest props via refs so
  // bucket/folder switches apply to files added afterwards only.
  const bucketRef = useRef(bucket);
  bucketRef.current = bucket;
  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;
  const overwriteRef = useRef(allowOverwrite);
  overwriteRef.current = allowOverwrite;
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const refresh = useCallback(() => {
    const uppy = uppyRef.current;
    setRows(uppy ? uppy.getFiles().map(toRow) : []);
  }, []);

  // One uppy instance per mount (StrictMode-safe): created here, destroyed on
  // unmount — destroying also aborts any in-flight TUS requests.
  useEffect(() => {
    const uppy = new Uppy<ResumableMeta, Body>({
      autoProceed: true,
      restrictions: { maxFileSize: RESUMABLE_MAX_BYTES },
    }).use(Tus, {
      endpoint: RESUMABLE_ENDPOINT,
      chunkSize: RESUMABLE_CHUNK_BYTES,
      retryDelays: RESUMABLE_RETRY_DELAYS,
      // Exactly the Upload-Metadata keys the proxy/storage API understand —
      // uppy's internal meta (name/type/relativePath) must not leak upstream.
      allowedMetaFields: ["bucketName", "objectName", "contentType", "cacheControl"],
      removeFingerprintOnSuccess: true,
      // x-upsert only when the caller opted into overwrite.
      headers: (): Record<string, string> =>
        overwriteRef.current ? { "x-upsert": "true" } : {},
    });

    uppy.on("file-added", (file) => {
      const objectName = buildObjectName(prefixRef.current, file.name);
      if (!objectName) {
        uppy.removeFile(file.id);
        setRejections((prev) => [
          ...prev,
          {
            name: file.name,
            reason:
              "Unsafe object name — letters, digits, spaces, dots, dashes and slashes only.",
          },
        ]);
        return;
      }
      uppy.setFileMeta(file.id, {
        bucketName: bucketRef.current,
        objectName,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      });
      refresh();
    });
    uppy.on("restriction-failed", (file, error) => {
      setRejections((prev) => [
        ...prev,
        { name: file?.name ?? "file", reason: error.message },
      ]);
    });
    uppy.on("file-removed", refresh);
    uppy.on("upload-progress", refresh);
    uppy.on("upload-pause", refresh);
    uppy.on("upload-error", refresh);
    uppy.on("upload-success", (file) => {
      refresh();
      const objectName = file?.meta.objectName;
      if (objectName) onUploadedRef.current?.(objectName);
    });

    uppyRef.current = uppy;
    return () => {
      uppyRef.current = null;
      uppy.destroy();
    };
  }, [refresh]);

  const addFiles = useCallback((files: ArrayLike<File>) => {
    const uppy = uppyRef.current;
    if (!uppy || !bucketRef.current) return;
    for (const file of Array.from(files)) {
      try {
        uppy.addFile(file);
      } catch {
        // Restriction failures already surface via the restriction-failed listener.
      }
    }
  }, []);

  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

  const pauseResume = (id: string) => {
    uppyRef.current?.pauseResume(id);
    refresh();
  };

  const retry = (id: string) => {
    void uppyRef.current?.retryUpload(id);
    refresh();
  };

  const remove = (id: string) => {
    uppyRef.current?.removeFile(id);
    refresh();
  };

  // Nothing queued, nothing to say — the panel exists only while uploads run.
  if (rows.length === 0 && rejections.length === 0) return null;

  return (
    <div className="stack">
      {rejections.map((r, i) => (
        <p key={`${r.name}-${i}`} className="form-error" role="alert">
          {r.name}: {r.reason}{" "}
          <button
            type="button"
            className="type-chip"
            aria-label={`Dismiss ${r.name}`}
            onClick={() => setRejections((prev) => prev.filter((_, j) => j !== i))}
          >
            Dismiss
          </button>
        </p>
      ))}

      {rows.map((row) => (
        <Surface
          key={row.id}
          elevated={false}
          style={{ padding: "10px 14px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span
              className="mono"
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.objectName}
            </span>
            <span className="mono" style={{ color: "var(--muted)", fontSize: "12px" }}>
              {formatBytes(row.bytesUploaded)} / {formatBytes(row.size)}
            </span>
            <span
              role="progressbar"
              aria-label={`Upload progress for ${row.objectName}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.percent}
              style={{
                flex: "0 0 auto",
                width: "160px",
                height: "6px",
                borderRadius: "999px",
                background: "var(--wash)",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  height: "100%",
                  width: `${row.percent}%`,
                  background: row.status === "error" ? "var(--fail)" : "var(--accent)",
                  transition: "width 0.2s ease",
                }}
              />
            </span>
            <Badge tone={STATUS_TONE[row.status]}>{row.status}</Badge>
            <span className="campaign-actions">
              {row.status === "uploading" || row.status === "paused" ? (
                <button
                  type="button"
                  className="type-chip"
                  aria-label={`${row.status === "paused" ? "Resume" : "Pause"} ${row.objectName}`}
                  onClick={() => pauseResume(row.id)}
                >
                  {row.status === "paused" ? "Resume" : "Pause"}
                </button>
              ) : null}
              {row.status === "error" ? (
                <button
                  type="button"
                  className="type-chip"
                  aria-label={`Retry ${row.objectName}`}
                  onClick={() => retry(row.id)}
                >
                  Retry
                </button>
              ) : null}
              <button
                type="button"
                className="type-chip"
                aria-label={`Remove ${row.objectName}`}
                onClick={() => remove(row.id)}
              >
                Remove
              </button>
            </span>
          </div>
          {row.error ? (
            <p className="form-error" role="alert">
              {row.error}
            </p>
          ) : null}
        </Surface>
      ))}
    </div>
  );
}

export default ResumableUploader;
