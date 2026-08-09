// The RAG "answer" panel — deliberately static. Answer synthesis (LLM calls)
// is DEFERRED pending the same sign-off as the W7 AI assistant; shipping a
// fake or "coming soon" answer box would be aspirational UI, so this panel
// says exactly what the feature does today. Server-safe.

import { Section } from "@/components/ui/Section";
import { RAG_DEFERRED_TEXT } from "./status";

export function RagAnswerPanel() {
  return (
    <Section
      title="Answer synthesis"
      description="Semantic retrieval is live; generated answers are not."
    >
      <p className="note">{RAG_DEFERRED_TEXT}</p>
    </Section>
  );
}

export default RagAnswerPanel;
