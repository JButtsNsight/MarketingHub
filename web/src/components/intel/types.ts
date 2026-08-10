// Pure types shared by the competitor-intel UI (client components) and the
// server pages that feed them props. Nothing server-only may be imported here.
// List-row shapes mirror the /api/intel route payloads (which mirror the repo
// summaries) — kept as local interfaces so client components never import the
// server-only repo module.

import type {
  DocumentStatus,
  IntelSource,
  SynthesisResult,
} from "@/lib/intel/schema";

/**
 * Client-side lifecycle of the async answer for ONE search (Wave-8R
 * two-phase UX). `none` covers keyword-only mode and zero-result searches;
 * `timeout` is the client-owned deadline — the gateway has no failed state,
 * so a crashed task reads `pending` forever and the browser must stop.
 */
export type AnswerPhase =
  | { name: "none" }
  | { name: "pending" }
  | { name: "completed"; result: SynthesisResult }
  | { name: "failed" }
  | { name: "timeout" };

/**
 * What the server knows about the embedding provider at render time, passed
 * into client components so the UI can label stub mode plainly ("similarity
 * illustrative until Bedrock enabled") and warn on corpus/query model
 * mismatches. `invalid` = CI_EMBED_PROVIDER is set to an unrecognized value —
 * an honest degraded state, never a crash.
 */
export interface EmbeddingProviderInfo {
  provider: "stub" | "bedrock" | "invalid";
  /** Provider model id (e.g. `stub-djb2-1024`, `amazon.titan-embed-text-v2:0`); null when invalid. */
  model: string | null;
  stub: boolean;
  /** Config error detail when provider = 'invalid'. */
  detail?: string;
}

/**
 * A sources-list row: the source plus aggregate counts merged from the
 * route's `stats` array. Counts are null only when stats were missing from
 * the response — rendered as an honest "—", never invented zeros.
 */
export interface IntelSourceSummary extends IntelSource {
  document_count: number | null;
  chunk_count: number | null;
}

/**
 * A documents-list row (no content body) — mirrors the repo's
 * IntelDocumentSummary returned by GET /api/intel/sources/:id.
 */
export interface IntelDocumentSummary {
  id: string;
  source_id: string;
  title: string;
  status: DocumentStatus;
  /** Consumer failure detail when status = 'error'. */
  error: string | null;
  created_at: string;
  updated_at: string;
  chunk_count: number;
}

/**
 * Aggregate chunk/embedding progress for one document, normalized from
 * GET /api/intel/documents/:id/status.
 */
export interface ChunkStatusSummary {
  total: number;
  embedded: number;
  /** Distinct embedding models present on this document's chunks. */
  models: string[];
  lastEmbeddedAt: string | null;
}
