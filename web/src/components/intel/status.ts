// Governed status + honesty copy for the competitor-intel UI. Status colors
// follow the StatusPill contract (red is reserved for failure); the strings
// below are the contract-mandated honest labels — keep them plain and true.

import type { DocumentStatus } from "@/lib/intel/schema";
import type { StatusKind } from "@/components/ui/StatusPill";

/** Document embedding lifecycle → governed status token. */
export function documentStatusKind(status: DocumentStatus): StatusKind {
  switch (status) {
    case "pending":
      return "idle";
    case "processing":
      return "run";
    case "embedded":
      return "ok";
    case "error":
      return "fail";
  }
}

/** Stub-mode label (contract wording) — shown wherever similarity appears. */
export const STUB_BADGE_TEXT =
  "stub embeddings — similarity illustrative until Bedrock enabled";

/** URL ingestion deferral label (contract wording). */
export const URL_FETCH_NOTE = "URL fetch: follow-up pending SSRF guardrails";

/** RAG answer panel (contract wording) — retrieval ships, synthesis doesn't. */
export const RAG_DEFERRED_TEXT =
  "Retrieval only — answer synthesis pending sign-off; no LLM calls.";

/** Honest queue-drain note for pending/processing documents. */
export const PENDING_NOTE =
  "Waiting on the embedding worker — it drains the queue about every 30 seconds. Refresh to see progress.";

/** Honest not-provisioned state (schema migration not applied here yet). */
export const NOT_PROVISIONED_TITLE = "Competitor intel isn't provisioned yet";
export const NOT_PROVISIONED_BODY =
  "The competitor_intel schema migration hasn't been applied to this environment. " +
  "Once the staged Wave-8 migration runs, sources, documents, and semantic search go live here.";
