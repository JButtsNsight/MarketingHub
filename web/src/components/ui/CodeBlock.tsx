"use client";

import { useState } from "react";
import { Surface } from "../Surface";

/**
 * A mono code sample with a copy button. Used for API examples (curl / SQL /
 * GraphQL). Clipboard failures are swallowed (non-fatal) — the sample is still
 * selectable by hand.
 */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (insecure context / denied) — non-fatal */
    }
  }

  return (
    <Surface className="code-block" glint>
      <div className="code-block-head">
        {label ? <span className="eyebrow">{label}</span> : <span />}
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-pre mono">
        <code>{code}</code>
      </pre>
    </Surface>
  );
}

export default CodeBlock;
