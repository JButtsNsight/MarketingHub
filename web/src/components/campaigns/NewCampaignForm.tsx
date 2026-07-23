"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Template } from "@/lib/templates/schema";
import { CampaignCreateInputSchema } from "@/lib/sms/schema";
import { unsupportedMergeFields } from "@/lib/sms/render";
import { Surface } from "../Surface";
import { Badge } from "../ui/Badge";
import { DataTable, type Column } from "../ui/DataTable";

/**
 * PERMANENT compliance copy — SimpleTexting signs no BAA, so message content
 * must never carry PHI. Do not soften or remove this warning.
 */
export const PHI_WARNING =
  "SimpleTexting has not signed a BAA. Message content must contain NO PHI — no conditions, medications, appointment or treatment details. Keep it generic.";

/** Shared "Monday is unconfigured" copy (preview 503 and create 503 alike). */
const MONDAY_UNCONFIGURED =
  "Monday.com is not configured — MONDAY_API_TOKEN is not set in this environment. See the deploy runbook (docs/runbooks/marketinghub-app-deploy.md).";

/** Response shape of POST /api/monday/board-preview (200). */
interface BoardPreview {
  boardId: string;
  boardName: string;
  columns: Array<{ id: string; title: string; type: string }>;
  phoneColumns: Array<{ id: string; title: string; type: string }>;
  suggestedPhoneColumnId: string | null;
  sample: Array<{
    name: string;
    phoneE164: string | null;
    reason: "ok" | "invalid" | "duplicate";
  }>;
  pageCounts: {
    fetched: number;
    valid: number;
    invalid: number;
    duplicate: number;
  };
}

type SampleRow = BoardPreview["sample"][number];

const SAMPLE_COLUMNS: Column<SampleRow>[] = [
  { key: "name", header: "name" },
  {
    key: "phone",
    header: "phone",
    mono: true,
    width: "160px",
    render: (r) => r.phoneE164 ?? "—",
  },
  {
    key: "reason",
    header: "reason",
    width: "110px",
    // invalid/duplicate are data classifications, not failures — never red.
    render: (r) => (
      <Badge tone={r.reason === "ok" ? "var(--ok)" : undefined}>
        {r.reason}
      </Badge>
    ),
  },
];

/** Today in America/New_York as YYYY-MM-DD — the send-date floor. */
function todayInEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Client creation form for an SMS campaign. Mirrors the server zod schema for
 * fast feedback (the server re-validates — the browser is never trusted):
 * template select with body preview + merge-field lint, board id/URL input
 * with a first-page preview via `/api/monday/board-preview`, phone-column
 * choice (suggested column pre-selected, any column allowed), and a send date
 * floored at today in America/New_York. Posts to the group-gated
 * `/api/campaigns` route and redirects to the new campaign.
 */
export function NewCampaignForm({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [board, setBoard] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [phoneColumnId, setPhoneColumnId] = useState("");
  const [preview, setPreview] = useState<BoardPreview | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const minDate = useMemo(() => todayInEastern(), []);
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const unsupported = selectedTemplate
    ? unsupportedMergeFields(selectedTemplate.body)
    : [];

  // Suggested (phone-type) columns first; every column stays choosable — some
  // boards keep phone numbers in plain text columns.
  const orderedColumns = useMemo(() => {
    if (!preview) return [];
    const phoneIds = new Set(preview.phoneColumns.map((c) => c.id));
    return [
      ...preview.phoneColumns,
      ...preview.columns.filter((c) => !phoneIds.has(c.id)),
    ];
  }, [preview]);

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
    } finally {
      setLoadingBoard(false);
    }
  };

  /** Client-side mirror of the server rules; returns an error string or null. */
  const validate = (): string | null => {
    if (!name.trim()) return "Campaign name is required.";
    if (!selectedTemplate) return "Choose a text template.";
    if (unsupported.length > 0)
      return "The selected template has unsupported merge fields — fix the template first.";
    if (!preview || !phoneColumnId)
      return "Load the board and choose a phone column.";
    if (!sendDate) return "Send date is required.";
    return null;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    // Same zod schema as the server — the pasted board URL is reduced to its
    // numeric id here, exactly like the API will do again.
    const parsed = CampaignCreateInputSchema.safeParse({
      name: name.trim(),
      templateId,
      mondayBoardId: board.trim(),
      mondayPhoneColumnId: phoneColumnId,
      sendDate,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Validation failed.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) {
        if (res.status === 503) {
          setError(MONDAY_UNCONFIGURED);
        } else if (res.status === 403) {
          setError("You do not have permission to create campaigns.");
        } else {
          const body = (await res
            .json()
            .catch(() => null)) as { error?: string } | null;
          setError(
            body?.error ??
              "Campaign creation failed. Please review the form and try again.",
          );
        }
        return;
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/campaigns/${id}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Surface
      as="form"
      className="upload-form"
      glint
      onSubmit={onSubmit}
      noValidate
    >
      <h1>New SMS campaign</h1>

      {/* Permanent compliance callout — never remove. */}
      <div className="ref-note" role="note">
        <Badge tone="var(--warn)">no phi</Badge>
        <span>{PHI_WARNING}</span>
      </div>

      <div className="field">
        <label htmlFor="camp-name">Campaign name</label>
        <input
          id="camp-name"
          className="surface control"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. August wellness recall"
        />
      </div>

      <div className="field">
        <label htmlFor="camp-template">Template</label>
        <select
          id="camp-template"
          className="surface control"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          <option value="">Choose a text template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {selectedTemplate ? (
          <>
            <pre className="code-pre mono">{selectedTemplate.body}</pre>
            {unsupported.length > 0 ? (
              <p className="form-error" role="alert">
                This template has unsupported merge fields:{" "}
                {unsupported.join(", ")}. Only {"{{name}}"} and{" "}
                {"{{firstName}}"} are supported.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor="camp-board">Monday board</label>
        <div className="field-row">
          <input
            id="camp-board"
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
      </div>

      {preview ? (
        <>
          <p className="note">
            Board <span className="mono">{preview.boardId}</span> —{" "}
            {preview.boardName}
          </p>

          <div className="field">
            <label htmlFor="camp-phone-column">Phone column</label>
            <select
              id="camp-phone-column"
              className="surface control"
              value={phoneColumnId}
              onChange={(e) => setPhoneColumnId(e.target.value)}
            >
              {phoneColumnId === "" ? (
                <option value="">Choose a column…</option>
              ) : null}
              {orderedColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.type})
                </option>
              ))}
            </select>
          </div>

          <p className="note mono">
            {preview.pageCounts.fetched} fetched · {preview.pageCounts.valid}{" "}
            valid · {preview.pageCounts.invalid} invalid ·{" "}
            {preview.pageCounts.duplicate} duplicate (first page)
          </p>
          <DataTable
            columns={SAMPLE_COLUMNS}
            rows={preview.sample}
            getRowKey={(r, i) => `${r.name}-${i}`}
            empty="No rows in the sampled page."
          />
        </>
      ) : null}

      <div className="field">
        <label htmlFor="camp-date">Send date (11:30 AM Eastern)</label>
        <input
          id="camp-date"
          type="date"
          className="surface control"
          value={sendDate}
          min={minDate}
          onChange={(e) => setSendDate(e.target.value)}
        />
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Creating…" : "Create campaign"}
        </button>
      </div>
    </Surface>
  );
}

export default NewCampaignForm;
