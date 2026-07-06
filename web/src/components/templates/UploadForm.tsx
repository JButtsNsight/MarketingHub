"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_TYPES,
  type TemplateType,
} from "@/lib/templates/schema";
import { Surface } from "../Surface";

/** Accepted file-drop extensions → content type stored with the upload. */
const ACCEPTED = ".txt,.html,.eml";

/** Normalize a raw tag the same way the server zod schema does. */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Client upload form for a campaign template. Mirrors the server zod schema for
 * fast feedback (the server re-validates — the browser is never trusted). Posts
 * to the group-gated `/api/templates` route and redirects to the new template.
 * Built on `.surface` so it honors the global glass/flat skin.
 */
export function UploadForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [type, setType] = useState<TemplateType>("text");
  const [category, setCategory] = useState<string>(TEMPLATE_CATEGORIES[0]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isEmail = type === "email";

  const addTag = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t) return;
    setTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
    setTagDraft("");
  };

  const removeTag = (t: string) =>
    setTags((prev) => prev.filter((x) => x !== t));

  const onTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setBody(text);
    setFilename(file.name);
    if (!name) setName(file.name.replace(/\.[^.]+$/, ""));
  };

  /** Client-side mirror of the zod rules; returns an error string or null. */
  const validate = (): string | null => {
    if (!name.trim()) return "Name is required.";
    if (!body.trim()) return "Body (or an uploaded file) is required.";
    if (isEmail && !subject.trim())
      return "Subject is required for email templates.";
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
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        type,
        category,
        tags,
        body,
      };
      if (isEmail) payload.subject = subject.trim();
      if (filename) payload.filename = filename;

      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "You do not have permission to upload templates."
            : "Upload failed. Please check the form and try again.",
        );
        return;
      }
      const { id } = (await res.json()) as { id: string };
      router.push(`/templates/${id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const categoryOptions = useMemo(() => [...TEMPLATE_CATEGORIES], []);

  return (
    <Surface as="form" className="upload-form" glint onSubmit={onSubmit} noValidate>
      <h1>Upload a template</h1>

      <div className="field">
        <label htmlFor="tpl-name">Name</label>
        <input
          id="tpl-name"
          className="surface control"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Spring Promo 2026"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="tpl-type">Type</label>
          <select
            id="tpl-type"
            className="surface control"
            value={type}
            onChange={(e) => setType(e.target.value as TemplateType)}
          >
            {TEMPLATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "text" ? "Text" : "Email"}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="tpl-category">Category</label>
          <select
            id="tpl-category"
            className="surface control"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isEmail && (
        <div className="field">
          <label htmlFor="tpl-subject">Subject</label>
          <input
            id="tpl-subject"
            className="surface control"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Email subject line"
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="tpl-tags">Tags</label>
        <div className="tag-input surface control">
          <ul className="tag-chips">
            {tags.map((t) => (
              <li key={t} className="tag-chip">
                <span>{t}</span>
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => removeTag(t)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <input
            id="tpl-tags"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={onTagKeyDown}
            onBlur={() => addTag(tagDraft)}
            placeholder="Add a tag, press Enter"
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="tpl-body">Body</label>
        <textarea
          id="tpl-body"
          className="surface control"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Paste template content, or drop a file below"
        />
      </div>

      <div className="field">
        <label htmlFor="tpl-file">Or upload a file ({ACCEPTED})</label>
        <input
          ref={fileInputRef}
          id="tpl-file"
          type="file"
          accept={ACCEPTED}
          className="surface control"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        {filename && <p className="field-note mono">Loaded: {filename}</p>}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Saving…" : "Save template"}
        </button>
      </div>
    </Surface>
  );
}

export default UploadForm;
