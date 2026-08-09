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

/** Default `match_count` for semantic search. */
export const SEARCH_DEFAULT_COUNT = 8;

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
