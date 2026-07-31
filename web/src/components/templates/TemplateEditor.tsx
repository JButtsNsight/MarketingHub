"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  TEMPLATE_CATEGORIES,
  type Template,
} from "@/lib/templates/schema";
import { unsupportedMergeFields } from "@/lib/sms/render";
import { Surface } from "../Surface";

/**
 * Inline template editor. Collapsed to an "Edit template" button; expanded it
 * PATCHes /api/templates/[id] and refreshes the server-rendered detail view.
 * `type` is not editable (flipping text↔email would strand campaigns built on
 * the template). Text bodies get the same merge-field lint as the campaign
 * builder — an unrenderable template would be rejected there anyway.
 */
export function TemplateEditor({ template }: { template: Template }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [category, setCategory] = useState(template.category);
  const [tags, setTags] = useState(template.tags.join(", "));
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const unsupported =
    template.type === "text" ? unsupportedMergeFields(body) : [];

  const onCancel = () => {
    setName(template.name);
    setCategory(template.category);
    setTags(template.tags.join(", "));
    setSubject(template.subject ?? "");
    setBody(template.body);
    setError(null);
    setEditing(false);
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!category.trim()) {
      setError("Category is required.");
      return;
    }
    if (!body.trim()) {
      setError("Body is required.");
      return;
    }
    if (template.type === "email" && !subject.trim()) {
      setError("Subject is required for email templates.");
      return;
    }
    if (unsupported.length > 0) {
      setError(
        `Unsupported merge fields: ${unsupported.join(", ")}. Only {{name}} and {{firstName}} are supported.`,
      );
      return;
    }

    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category: category.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          subject: subject.trim(),
          body,
        }),
      });
      if (!res.ok) {
        const payload = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "Save failed. Please try again.");
        setSaving(false);
        return;
      }
      setSaving(false);
      setEditing(false);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="btn-primary"
        onClick={() => setEditing(true)}
      >
        Edit template
      </button>
    );
  }

  return (
    <Surface as="form" className="upload-form tpl-editor" glint onSubmit={onSave} noValidate>
      <h2>Edit template</h2>

      <div className="field">
        <label htmlFor="tpl-name">Name</label>
        <input
          id="tpl-name"
          className="surface control"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="tpl-category">Category</label>
        <input
          id="tpl-category"
          className="surface control"
          list="tpl-category-options"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <datalist id="tpl-category-options">
          {TEMPLATE_CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      <div className="field">
        <label htmlFor="tpl-tags">Tags (comma-separated)</label>
        <input
          id="tpl-tags"
          className="surface control"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="promo, seasonal"
        />
      </div>

      {template.type === "email" ? (
        <div className="field">
          <label htmlFor="tpl-subject">Subject</label>
          <input
            id="tpl-subject"
            className="surface control"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="tpl-body">Body</label>
        <textarea
          id="tpl-body"
          className="surface control"
          rows={template.type === "email" ? 10 : 5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {template.type === "text" ? (
          <p className="note mono">
            {body.length} chars
            {unsupported.length > 0
              ? ` · unsupported merge fields: ${unsupported.join(", ")}`
              : " · {{name}} and {{firstName}} supported"}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="button" className="type-chip" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Surface>
  );
}

export default TemplateEditor;
