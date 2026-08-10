import { z } from "zod";

// Pure module — imported by client components, API routes, the repo layer and
// the worker consumer alike. Nothing server-only or node-only may be imported
// here. Row interfaces mirror the `competitor_intel` schema tables (Wave 8);
// downstream builders import THESE, not the generated database types.

/** PostgREST-exposed schema that owns the competitor-intel tables. */
export const INTEL_SCHEMA = "competitor_intel";

/** pgmq queue drained by the worker's embedding consumer. */
export const INTEL_EMBED_QUEUE = "ci_embed";

/**
 * Embedding vector width. Titan V2's default (and the stub's) — mirrors the
 * DB `vector(1024)` column, comfortably under pgvector's 2000-dim HNSW limit.
 */
export const EMBEDDING_DIMS = 1024;

/**
 * The two source kinds. Mirrors the DB `kind` check constraint. `url` is
 * reference metadata only for now — URL fetching is a follow-up pending SSRF
 * guardrails; ingestion is paste-text in both cases.
 */
export const SOURCE_KINDS = ["text", "url"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Document embedding lifecycle. Mirrors the DB `status` check constraint. */
export const DOCUMENT_STATUSES = [
  "pending",
  "processing",
  "embedded",
  "error",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Paste-text ceiling (~125k tokens ≈ 250+ chunks) — keeps requests sane.
 * Enforced in three layers: zod at the API route, a CHECK constraint on
 * `documents.content` (belt-and-suspenders for direct PostgREST writers),
 * and the worker consumer's pre-chunk guard (dead-letters oversized rows
 * instead of embedding them).
 */
export const DOCUMENT_CONTENT_MAX_CHARS = 500_000;

/**
 * Consumer-side ceiling on chunks per document. A max-size (500k-char)
 * document chunks to ~350 pieces; anything past this bound means an
 * oversized/pathological row reached the table and embedding it would risk
 * the 512 MiB worker task (per-chunk provider calls + one large chunk-row
 * insert) — the consumer dead-letters it instead.
 */
export const DOCUMENT_MAX_CHUNKS = 400;

/** `match_chunks` caps at 50 rows server-side (`least(match_count, 50)`). */
export const SEARCH_MAX_COUNT = 50;

/**
 * Default `match_count` for search. 16 (was 8): one retrieved list serves
 * both the displayed passages AND answer synthesis — citations must always
 * point at rows the user can see.
 */
export const SEARCH_DEFAULT_COUNT = 16;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Optional free-text field: absent / null / blank → null, otherwise trimmed.
 * Forms submit empty strings; the DB stores null.
 */
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((value) => (value ? value : null));

const urlField = optionalText.refine(
  (value) => value === null || isHttpUrl(value),
  { message: "url must be a valid http(s) URL" },
);

const notesField = optionalText.refine(
  (value) => value === null || value.length <= 4000,
  { message: "notes must be 4000 characters or fewer" },
);

const nameField = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(200, "name must be 200 characters or fewer");

/** Validated input for creating a competitor-intel source. */
export const SourceCreateInputSchema = z
  .object({
    name: nameField,
    kind: z.enum(SOURCE_KINDS).default("text"),
    url: urlField,
    notes: notesField,
  })
  .refine((value) => value.kind !== "url" || value.url !== null, {
    message: "url is required when kind is 'url'",
    path: ["url"],
  });
export type SourceCreateInput = z.infer<typeof SourceCreateInputSchema>;

/**
 * Validated input for editing a source. Absent keys mean "leave unchanged";
 * explicit null (or blank) on url/notes clears the column.
 */
export const SourceUpdateInputSchema = z
  .object({
    name: nameField.optional(),
    kind: z.enum(SOURCE_KINDS).optional(),
    url: z
      .union([z.string(), z.null()])
      .transform((value) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed.length > 0 ? trimmed : null;
      })
      .refine((value) => value === null || isHttpUrl(value), {
        message: "url must be a valid http(s) URL",
      })
      .optional(),
    notes: z
      .union([z.string(), z.null()])
      .transform((value) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed.length > 0 ? trimmed : null;
      })
      .refine((value) => value === null || value.length <= 4000, {
        message: "notes must be 4000 characters or fewer",
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.kind !== undefined ||
      value.url !== undefined ||
      value.notes !== undefined,
    { message: "at least one field must be provided" },
  );
export type SourceUpdateInput = z.infer<typeof SourceUpdateInputSchema>;

/**
 * Validated input for pasting a document into a source. Content is kept raw
 * (not trimmed) — the chunker relies on headings/paragraph structure.
 */
export const DocumentCreateInputSchema = z.object({
  sourceId: z.string().uuid("sourceId must be a UUID"),
  title: z
    .string()
    .trim()
    .min(1, "title is required")
    .max(300, "title must be 300 characters or fewer"),
  content: z
    .string()
    .max(
      DOCUMENT_CONTENT_MAX_CHARS,
      `content must be ${DOCUMENT_CONTENT_MAX_CHARS.toLocaleString()} characters or fewer`,
    )
    .refine((value) => value.trim().length > 0, {
      message: "content is required",
    }),
});
export type DocumentCreateInput = z.infer<typeof DocumentCreateInputSchema>;

/** Validated input for semantic search (`q` arrives via query params). */
export const SearchInputSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, "q is required")
    .max(2000, "q must be 2000 characters or fewer"),
  sourceId: z
    .string()
    .uuid("sourceId must be a UUID")
    .nullish()
    .transform((value) => value ?? null),
  count: z.coerce
    .number()
    .int("count must be an integer")
    .min(1, "count must be at least 1")
    .max(SEARCH_MAX_COUNT, `count must be at most ${SEARCH_MAX_COUNT}`)
    .default(SEARCH_DEFAULT_COUNT),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

/** A row of `competitor_intel.sources`. */
export interface IntelSource {
  id: string;
  name: string;
  kind: SourceKind;
  /** Reference metadata only — never fetched (SSRF guardrails pending). */
  url: string | null;
  notes: string | null;
  /** `auth.uid()` of the creator; null when written by the service role. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A row of `competitor_intel.documents`. */
export interface IntelDocument {
  id: string;
  source_id: string;
  title: string;
  content: string;
  status: DocumentStatus;
  /** Consumer failure detail when status = 'error'. */
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** A row of `competitor_intel.chunks`. */
export interface IntelChunk {
  id: number;
  document_id: string;
  seq: number;
  content: string;
  token_estimate: number;
  /**
   * `vector(1024)`. PostgREST serializes vectors as strings (`"[0.1,...]"`)
   * on read and accepts `number[]` on write; null until embedded.
   */
  embedding: string | number[] | null;
  /** Provider/model that produced the vector (e.g. stub vs Titan). */
  embedding_model: string | null;
  embedded_at: string | null;
}

/**
 * One row returned by the `competitor_intel.match_chunks` RPC — chunk plus
 * document/source context. `similarity` = 1 - cosine distance.
 */
export interface MatchChunkRow {
  chunk_id: number;
  document_id: string;
  source_id: string;
  seq: number;
  content: string;
  similarity: number;
  embedding_model: string | null;
  document_title: string;
  source_name: string;
}

// ---------------------------------------------------------------------------
// Wave-8R agentic search (2026-08-10): Postgres FTS candidates → headless-
// claude gateway rerank + synthesis with citations. The pgvector path above
// (match_chunks / MatchChunkRow / embedding fields) stays dormant and intact.
// ---------------------------------------------------------------------------

/**
 * One row returned by the `competitor_intel.search_chunks_fts` RPC — chunk
 * plus document/source context. `rank` = `ts_rank_cd` keyword relevance.
 */
export interface FtsChunkRow {
  chunk_id: number;
  document_id: string;
  source_id: string;
  seq: number;
  content: string;
  rank: number;
  document_title: string;
  source_name: string;
}

/**
 * How a search was served: `agentic` = FTS candidates + gateway synthesis;
 * `keyword-only` = FTS ranking alone (gateway unconfigured or unavailable).
 */
export type SearchMode = "agentic" | "keyword-only";

/** Honest degraded-state marker attached to keyword-only responses. */
export interface SearchDegraded {
  reason: "gateway-not-configured" | "synthesis-unavailable";
  detail?: string;
}

/**
 * The JSON object the model must emit (prompt-engineered — the gateway has
 * no JSON mode). `citations`/`ranking` are 1-BASED PASSAGE NUMBERS into the
 * retrieved results array; all mapping to real chunk/document/source data
 * happens client-side from the caller's own rows, so out-of-range numbers
 * can only ever be dropped, never dereferenced.
 */
export const SynthesisResultSchema = z.object({
  answer: z.string().min(1).max(8000),
  citations: z.array(z.number().int().min(1).max(50)).max(50),
  ranking: z.array(z.number().int().min(1).max(50)).max(50),
});
export type SynthesisResult = z.infer<typeof SynthesisResultSchema>;

/** Answer slot in the initial search response (async two-phase UX). */
export type SearchAnswer =
  | { state: "pending"; taskId: string }
  | ({ state: "completed" } & SynthesisResult);

/** Response shape of GET /api/intel/search. */
export interface SearchResponse {
  query: string;
  mode: SearchMode;
  results: FtsChunkRow[];
  answer: SearchAnswer | null;
  degraded: SearchDegraded | null;
}

/** Response shape of GET /api/intel/search/answer/[taskId] (poll endpoint). */
export type AnswerResponse =
  | { state: "pending" }
  | ({ state: "completed" } & SynthesisResult)
  | { state: "failed"; reason: string };

/**
 * Task-id namespace for our gateway submissions. The answer route rejects
 * anything else so the shared gateway key can never be used as an oracle to
 * read other ClaudeCloud clients' task results.
 */
export const INTEL_TASK_ID_RE =
  /^mh-intel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Output cap for the synthesis task (gateway `max_tokens`). */
export const SYNTHESIS_MAX_TOKENS = 1500;

/** Hard cap on the synthesis prompt; trailing candidates are dropped. */
export const SYNTHESIS_PROMPT_MAX_CHARS = 150_000;

/**
 * Byte budget for the JSON-ENCODED synthesis prompt. The gateway's POST /task
 * limit is 256KB of serialized request body, and JS chars under-count it:
 * JSON escaping and UTF-8 expand multibyte content 2–4x, so a prompt that
 * passes the char cap can still overflow the body. The passage loop budgets
 * escaped bytes against this too, leaving headroom for the request envelope
 * (system prompt, task id, model fields).
 */
export const SYNTHESIS_PROMPT_MAX_BYTES = 200_000;

/** Browser poll cadence for a pending answer. */
export const ANSWER_POLL_INTERVAL_MS = 3000;

/**
 * Client-owned deadline: the gateway has NO failed state (crashed/dropped
 * tasks read `pending` forever), so the browser stops polling here.
 */
export const ANSWER_POLL_DEADLINE_MS = 90_000;
