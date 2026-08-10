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

// --- Wave-8R agentic search copy (2026-08-10). Honesty rule: every degraded
// path states plainly what works and what doesn't — no aspirational copy.

/** Gateway env absent → keyword ranking works, synthesis does not. */
export const KEYWORD_ONLY_TEXT =
  "Answer synthesis is not configured on this environment — results below are " +
  "keyword-ranked only; no answer will be generated.";

/** Candidates submitted; the gateway is synthesizing asynchronously. */
export const SYNTHESIS_PENDING_TEXT =
  "Synthesizing an answer from the passages below — usually 10–60 seconds.";

/** The gateway returned, but no usable answer came back. */
export const SYNTHESIS_FAILED_TEXT =
  "Answer synthesis failed for this search. The keyword-ranked passages below " +
  "are still valid — try searching again for an answer.";

/**
 * Client-owned deadline elapsed (the gateway has no failed state). Honesty
 * detail: the copy must NOT promise that an immediate retry gets an answer —
 * identical searches re-attach to the same (possibly dead) task for up to
 * 5 minutes (the search route's in-flight dedupe window).
 */
export const SYNTHESIS_TIMEOUT_TEXT =
  "No answer arrived within 90 seconds, so polling stopped. The keyword-ranked " +
  "passages below are still valid — try again in a few minutes for an answer.";

/** Shown with every synthesized answer — provenance is the passages, not us. */
export const ANSWER_DISCLAIMER_TEXT =
  "Synthesized by Claude from the passages below — verify against cited sources.";

/** Honest queue-drain note for pending/processing documents. */
export const PENDING_NOTE =
  "Waiting on the embedding worker — it drains the queue about every 30 seconds. Refresh to see progress.";

/** Honest not-provisioned state (schema migration not applied here yet). */
export const NOT_PROVISIONED_TITLE = "Competitor intel isn't provisioned yet";
export const NOT_PROVISIONED_BODY =
  "The competitor_intel schema migration hasn't been applied to this environment. " +
  "Once the staged Wave-8 migration runs, sources, documents, and semantic search go live here.";
