"use client";

// The synthesized-answer panel (Wave-8R agentic search). Renders the async
// answer lifecycle honestly: synthesizing → answer / failed / timed out.
//
// Trust rules (spec-mandated, do not relax):
// - The answer renders as PLAIN TEXT (pre-wrap). No markdown rendering, no
//   dangerouslySetInnerHTML, no auto-linkification — the model reads pasted
//   competitor material, so injection may put URLs or directives in the text;
//   they must stay inert characters.
// - Citations are 1-based passage numbers only. ALL mapping to real
//   document/source data happens HERE from the caller's own retrieved rows;
//   out-of-range numbers are silently dropped, so a citation can only ever
//   point at a passage the user can see.

import Link from "next/link";
import type { FtsChunkRow } from "@/lib/intel/schema";
import { Section } from "@/components/ui/Section";
import {
  ANSWER_DISCLAIMER_TEXT,
  SYNTHESIS_FAILED_TEXT,
  SYNTHESIS_PENDING_TEXT,
  SYNTHESIS_TIMEOUT_TEXT,
} from "./status";
import type { AnswerPhase } from "./types";

export function RagAnswerPanel({
  phase,
  rows,
}: {
  phase: AnswerPhase;
  /** The retrieved passages, in ORIGINAL retrieval order (citation space). */
  rows: FtsChunkRow[];
}) {
  if (phase.name === "none") return null;

  return (
    <Section title="Answer" eyebrow="synthesis">
      {phase.name === "pending" ? (
        <p className="muted" role="status" aria-busy="true">
          {SYNTHESIS_PENDING_TEXT}
        </p>
      ) : null}

      {phase.name === "failed" ? (
        <p className="note" role="alert">
          {SYNTHESIS_FAILED_TEXT}
        </p>
      ) : null}

      {phase.name === "timeout" ? (
        <p className="note" role="alert">
          {SYNTHESIS_TIMEOUT_TEXT}
        </p>
      ) : null}

      {phase.name === "completed" ? (
        <>
          {/* Plain text on purpose — see the trust rules above. */}
          <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {phase.result.answer}
          </p>
          <CitationChips citations={phase.result.citations} rows={rows} />
          <p className="muted">{ANSWER_DISCLAIMER_TEXT}</p>
        </>
      ) : null}
    </Section>
  );
}

/**
 * Map cited passage numbers onto the retrieved rows. De-duplicated; numbers
 * outside 1..rows.length are dropped without comment (they cannot refer to
 * anything the user was shown, so rendering them would fabricate provenance).
 */
function CitationChips({
  citations,
  rows,
}: {
  citations: number[];
  rows: FtsChunkRow[];
}) {
  const cited = [...new Set(citations)].filter(
    (n) => Number.isInteger(n) && n >= 1 && n <= rows.length,
  );
  if (cited.length === 0) return null;
  return (
    <div
      className="note"
      style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}
    >
      <span>Cited passages:</span>
      {cited.map((n) => {
        const row = rows[n - 1];
        return (
          <Link
            key={n}
            className="type-chip"
            href={`/intel/documents/${row.document_id}`}
            title={`${row.source_name} › ${row.document_title}`}
          >
            [{n}] {row.document_title}
          </Link>
        );
      })}
    </div>
  );
}

export default RagAnswerPanel;
