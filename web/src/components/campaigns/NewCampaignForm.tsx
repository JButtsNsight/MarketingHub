"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Template } from "@/lib/templates/schema";
import type { ContactList } from "@/lib/contacts/schema";
import { CampaignCreateInputSchema } from "@/lib/sms/schema";
import { unsupportedMergeFields } from "@/lib/sms/render";
import { Surface } from "../Surface";
import { Badge } from "../ui/Badge";

/**
 * PERMANENT compliance copy — SimpleTexting signs no BAA, so message content
 * must never carry PHI. Do not soften or remove this warning.
 */
export const PHI_WARNING =
  "SimpleTexting has not signed a BAA. Message content must contain NO PHI — no conditions, medications, appointment or treatment details. Keep it generic.";

/** Shared "Monday is unconfigured" copy (surfaced on a create 503). */
const MONDAY_UNCONFIGURED =
  "Monday.com is not configured — MONDAY_API_TOKEN is not set in this environment. See the deploy runbook (docs/runbooks/marketinghub-app-deploy.md).";

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
 * template select with body preview + merge-field lint, a contact-list select
 * (audiences are managed under Campaigns → Contact lists), and a send date
 * floored at today in America/New_York. Posts to the group-gated
 * `/api/campaigns` route and redirects to the new campaign.
 */
export function NewCampaignForm({
  templates,
  lists,
}: {
  templates: Template[];
  lists: ContactList[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [contactListId, setContactListId] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const minDate = useMemo(() => todayInEastern(), []);
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const selectedList = lists.find((l) => l.id === contactListId) ?? null;
  const unsupported = selectedTemplate
    ? unsupportedMergeFields(selectedTemplate.body)
    : [];

  /** Client-side mirror of the server rules; returns an error string or null. */
  const validate = (): string | null => {
    if (!name.trim()) return "Campaign name is required.";
    if (!selectedTemplate) return "Choose a text template.";
    if (unsupported.length > 0)
      return "The selected template has unsupported merge fields — fix the template first.";
    if (!selectedList) return "Choose a contact list.";
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

    // Same zod schema as the server.
    const parsed = CampaignCreateInputSchema.safeParse({
      name: name.trim(),
      templateId,
      contactListId,
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
        } else if (res.status === 409) {
          setError(
            "Duplicate campaign — an identical campaign already exists. Check the campaigns list before creating it again.",
          );
        } else {
          const body = (await res
            .json()
            .catch(() => null)) as { error?: string } | null;
          setError(
            body?.error ??
              "Campaign creation failed. Please review the form and try again.",
          );
        }
        setSubmitting(false);
        return;
      }
      const { id } = (await res.json()) as { id: string };
      // Deliberately NOT re-enabling the button here: router.push navigation
      // is async, and re-enabling opens a double-submit (double-create)
      // window. `submitting` only resets on the error paths above/below.
      router.push(`/campaigns/${id}`);
    } catch {
      setError("Network error — please try again.");
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
        <p className="note">
          Templates are managed under{" "}
          <Link href="/templates">Templates</Link> — edits there show up here.
        </p>
      </div>

      <div className="field">
        <label htmlFor="camp-list">Contact list</label>
        <select
          id="camp-list"
          className="surface control"
          value={contactListId}
          onChange={(e) => setContactListId(e.target.value)}
        >
          <option value="">Choose a contact list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.source === "monday"
                ? ` — Monday: ${l.monday_board_name ?? l.monday_board_id} (live)`
                : ` — sheet, ${l.contact_count} contacts`}
            </option>
          ))}
        </select>
        {selectedList ? (
          <p className="note">
            {selectedList.source === "monday" ? (
              <>
                Linked board{" "}
                <span className="mono">#{selectedList.monday_board_id}</span> —
                recipients are fetched live at creation.
              </>
            ) : (
              <>
                <span className="mono">{selectedList.contact_count}</span>{" "}
                usable contacts from{" "}
                <span className="mono">{selectedList.original_filename}</span>.
              </>
            )}{" "}
            <Link href={`/campaigns/lists/${selectedList.id}`}>View list</Link>
          </p>
        ) : (
          <p className="note">
            Audiences are managed under{" "}
            <Link href="/campaigns/lists">Contact lists</Link> — upload a sheet
            or link a Monday board there.
          </p>
        )}
      </div>

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
