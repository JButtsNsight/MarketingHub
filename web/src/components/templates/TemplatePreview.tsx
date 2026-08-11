"use client";

import { useState } from "react";
import type { Template } from "@/lib/templates/schema";

/**
 * Renders a template's content.
 *
 * - `text`: the body verbatim in a monospace-safe `.surface` panel.
 * - `email`: the subject line plus an HTML preview rendered in a **sandboxed**
 *   `<iframe srcDoc>`. The sandbox attribute is EMPTY — every capability
 *   (scripts, forms, top-navigation, same-origin) is withheld — so campaign HTML
 *   is shown but never executed. A "View source" action swaps to the raw HTML
 *   (and back) — an action button whose label names what it shows next, not a
 *   pressed-state toggle.
 */
export function TemplatePreview({ template }: { template: Template }) {
  const [showSource, setShowSource] = useState(false);

  if (template.type === "text") {
    return <pre className="preview-text surface mono">{template.body}</pre>;
  }

  return (
    <div className="preview-email">
      <div className="preview-header">
        <p className="preview-subject">
          <span className="preview-subject-label">Subject</span>
          {template.subject}
        </p>
        <button
          type="button"
          className="type-chip"
          onClick={() => setShowSource((s) => !s)}
        >
          {showSource ? "View preview" : "View source"}
        </button>
      </div>

      {showSource ? (
        <pre className="preview-source surface mono">{template.body}</pre>
      ) : (
        <iframe
          className="preview-frame surface"
          title={`Email preview: ${template.name}`}
          sandbox=""
          srcDoc={template.body}
        />
      )}
    </div>
  );
}

export default TemplatePreview;
