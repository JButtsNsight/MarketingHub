"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  parseContactSheet,
  SheetParseError,
  type ParsedSheet,
} from "@/lib/contacts/csv";
import { Surface } from "../Surface";
import { Badge } from "../ui/Badge";

/** Shared "Monday is unconfigured" copy (matches the campaign form). */
const MONDAY_UNCONFIGURED =
  "Monday.com is not configured — MONDAY_API_TOKEN is not set in this environment. See the deploy runbook (docs/runbooks/marketinghub-app-deploy.md).";

/** The subset of /api/monday/board-preview this form uses. */
interface BoardPreview {
  boardId: string;
  boardName: string;
  columns: Array<{ id: string; title: string; type: string }>;
  phoneColumns: Array<{ id: string; title: string; type: string }>;
  suggestedPhoneColumnId: string | null;
}

type Mode = "csv" | "monday";

/**
 * Contact-list creation form: upload a sheet (parsed + classified in the
 * browser for instant feedback; the server re-parses — the browser is never
 * trusted) or link a Monday board via the existing board-preview endpoint.
 */
export function NewListForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("csv");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // csv state
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileText, setFileText] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);

  // monday state
  const [board, setBoard] = useState("");
  const [preview, setPreview] = useState<BoardPreview | null>(null);
  const [phoneColumnId, setPhoneColumnId] = useState("");
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    setSheet(null);
    setFileText(null);
    setFileName(null);
    setError(null);
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      setError(
        "Excel workbooks aren't supported directly — export the sheet as CSV first (File → Save As → CSV).",
      );
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setFileText(text);
    if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    try {
      setSheet(parseContactSheet(text));
    } catch (err) {
      setError(
        err instanceof SheetParseError
          ? err.message
          : "Could not parse that file.",
      );
    }
  };

  const onLoadBoard = async () => {
    setBoardError(null);
    const value = board.trim();
    if (!value) {
      setBoardError("Enter a Monday board id or a pasted board URL.");
      return;
    }
    setLoadingBoard(true);
    try {
      const res = await fetch("/api/monday/board-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ board: value }),
      });
      if (!res.ok) {
        setPreview(null);
        setPhoneColumnId("");
        setBoardError(
          res.status === 503
            ? MONDAY_UNCONFIGURED
            : res.status === 404
              ? "Board not found — check the id/URL and the token's board access."
              : res.status === 400
                ? "Enter a numeric Monday board id or a pasted board URL."
                : "Board preview failed. Please try again.",
        );
        return;
      }
      const data = (await res.json()) as BoardPreview;
      setPreview(data);
      setPhoneColumnId(data.suggestedPhoneColumnId ?? "");
      if (!name.trim()) setName(data.boardName);
    } catch {
      setPreview(null);
      setPhoneColumnId("");
      setBoardError("Network error — please try again.");
    } finally {
      setLoadingBoard(false);
    }
  };

  const validate = (): string | null => {
    if (!name.trim()) return "List name is required.";
    if (mode === "csv") {
      if (!fileText || !fileName) return "Choose a CSV file to upload.";
      if (!sheet) return "Fix the file problem above first.";
      if (sheet.counts.ok === 0)
        return "No usable contacts in that file — nothing could ever send.";
    } else {
      if (!preview || !phoneColumnId)
        return "Load the board and choose a phone column.";
    }
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSubmitting(true);

    const payload =
      mode === "csv"
        ? {
            source: "csv" as const,
            name: name.trim(),
            filename: fileName,
            content: fileText,
          }
        : {
            source: "monday" as const,
            name: name.trim(),
            board: board.trim(),
            phoneColumnId,
          };

    try {
      const res = await fetch("/api/contact-lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        setError(
          res.status === 503
            ? MONDAY_UNCONFIGURED
            : (body?.error ?? "List creation failed. Please try again."),
        );
        setSubmitting(false);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      // Not re-enabling the button: router.push is async and re-enabling
      // opens a double-submit window (same rule as the campaign form).
      router.push(`/campaigns/lists/${id}`);
    } catch {
      setError("Network error — please try again.");
      setSubmitting(false);
    }
  };

  return (
    <Surface as="form" className="upload-form" glint onSubmit={onSubmit} noValidate>
      <h1>New contact list</h1>

      <div className="field">
        <span className="field-label">Source</span>
        <Surface as="div" role="group" aria-label="List source" className="seg" elevated={false}>
          <button
            type="button"
            className={mode === "csv" ? "seg-btn on" : "seg-btn"}
            aria-pressed={mode === "csv"}
            onClick={() => setMode("csv")}
          >
            Upload sheet
          </button>
          <button
            type="button"
            className={mode === "monday" ? "seg-btn on" : "seg-btn"}
            aria-pressed={mode === "monday"}
            onClick={() => setMode("monday")}
          >
            Link Monday board
          </button>
        </Surface>
      </div>

      <div className="field">
        <label htmlFor="list-name">List name</label>
        <input
          id="list-name"
          className="surface control"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. August recall patients"
        />
      </div>

      {mode === "csv" ? (
        <div className="field">
          <label htmlFor="list-file">Contacts file (.csv / .tsv)</label>
          <input
            id="list-file"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="surface control"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <p className="note">
            Needs a header row with a phone column ("phone", "mobile",
            "cell"…). A name column is used for {"{{name}}"} /{" "}
            {"{{firstName}}"} merge fields when present.
          </p>
          {sheet ? (
            <p className="note mono">
              {sheet.counts.total} rows · {sheet.counts.ok}{" "}
              <Badge tone="var(--ok)">ok</Badge> · {sheet.counts.invalid}{" "}
              invalid · {sheet.counts.duplicate} duplicate — phone column
              &ldquo;{sheet.phoneHeader}&rdquo;
              {sheet.nameHeader ? <> · name column &ldquo;{sheet.nameHeader}&rdquo;</> : null}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="field">
          <label htmlFor="list-board">Monday board</label>
          <div className="board-row">
            <input
              id="list-board"
              className="surface control"
              value={board}
              onChange={(e) => setBoard(e.target.value)}
              placeholder="Board id or pasted board URL"
            />
            <button
              type="button"
              className="type-chip"
              onClick={onLoadBoard}
              disabled={loadingBoard}
            >
              {loadingBoard ? "Loading…" : "Load board"}
            </button>
          </div>
          {boardError ? (
            <p className="form-error" role="alert">
              {boardError}
            </p>
          ) : null}
          {preview ? (
            <>
              <p className="note">
                Board <span className="mono">{preview.boardId}</span> —{" "}
                {preview.boardName}
              </p>
              <label htmlFor="list-phone-column">Phone column</label>
              <select
                id="list-phone-column"
                className="surface control"
                value={phoneColumnId}
                onChange={(e) => setPhoneColumnId(e.target.value)}
              >
                {phoneColumnId === "" ? (
                  <option value="">Choose a column…</option>
                ) : null}
                {[
                  ...preview.phoneColumns,
                  ...preview.columns.filter(
                    (c) => !preview.phoneColumns.some((p) => p.id === c.id),
                  ),
                ].map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.type})
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create list"}
        </button>
      </div>
    </Surface>
  );
}

export default NewListForm;
