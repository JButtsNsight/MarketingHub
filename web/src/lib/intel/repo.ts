import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getServiceClient } from "../supabase";
import { providerFromEnv } from "./providers";
import {
  INTEL_SCHEMA,
  SEARCH_DEFAULT_COUNT,
  SEARCH_MAX_COUNT,
  type DocumentCreateInput,
  type DocumentStatus,
  type FtsChunkRow,
  type IntelDocument,
  type IntelSource,
  type MatchChunkRow,
  type SourceCreateInput,
  type SourceUpdateInput,
} from "./schema";

// Competitor-intel data layer (Wave 8). W4 cutover style: every exported fn
// takes an optional TRAILING `db?: SupabaseClient` — routes thread
// `getUserClient(user)` so requests run as `authenticated` under RLS;
// omitted ⇒ the memoized service-role client (worker/back-office paths).
//
// Embedding is asynchronous: `createDocument` only inserts the row — DB
// triggers enqueue the pgmq `ci_embed` job and the worker consumer chunks +
// embeds out-of-band. `chunkStatus` is the honest progress read.

const SCHEMA = INTEL_SCHEMA;
const SOURCES = "sources";
const DOCUMENTS = "documents";
const CHUNKS = "chunks";

/**
 * The `competitor_intel` substrate is not applied/exposed yet (migration not
 * run, or the schema is missing from PGRST_DB_SCHEMAS). Typed so routes and
 * server pages can render an honest "not provisioned" state instead of a 500.
 */
export class NotProvisionedError extends Error {
  constructor(op: string, detail: string) {
    super(`[intel] ${op}: competitor_intel is not provisioned yet (${detail})`);
    this.name = "NotProvisionedError";
  }
}

/**
 * PostgREST signatures for a missing schema/table/function:
 * - PGRST106 — schema not in PGRST_DB_SCHEMAS (db-schemas config)
 * - PGRST205 / 42P01 — table absent (schema cache / undefined_table)
 * - PGRST202 — function absent (match_chunks not migrated)
 * - 3F000 — invalid_schema_name (schema itself absent in the DB)
 */
function isNotProvisioned(error: { code?: string; message?: string }): boolean {
  const code = error.code ?? "";
  if (["PGRST106", "PGRST202", "PGRST205", "42P01", "3F000"].includes(code)) {
    return true;
  }
  const message = error.message ?? "";
  return /schema must be one of|does not exist|could not find the/i.test(
    message,
  );
}

function fail(op: string, message: string): never {
  throw new Error(`[intel] ${op} failed: ${message}`);
}

/** Map a PostgREST error: provisioning gaps typed, everything else fail-loud. */
function guard(
  op: string,
  error: { code?: string; message?: string } | null,
): void {
  if (!error) return;
  if (isNotProvisioned(error)) {
    throw new NotProvisionedError(op, error.message ?? error.code ?? "unknown");
  }
  fail(op, error.message ?? "unknown error");
}

function nowIso(): string {
  return new Date().toISOString();
}

function sources(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(SOURCES);
}

function documents(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(DOCUMENTS);
}

function chunks(db: SupabaseClient = getServiceClient()) {
  return db.schema(SCHEMA).from(CHUNKS);
}

// ---------------------------------------------------------------------------
// Sources CRUD
// ---------------------------------------------------------------------------

export async function listSources(db?: SupabaseClient): Promise<IntelSource[]> {
  const { data, error } = await sources(db)
    .select("*")
    .order("created_at", { ascending: false });
  guard("list-sources", error);
  return (data ?? []) as IntelSource[];
}

export async function getSource(
  id: string,
  db?: SupabaseClient,
): Promise<IntelSource | null> {
  const { data, error } = await sources(db).select("*").eq("id", id).maybeSingle();
  guard("get-source", error);
  return (data as IntelSource | null) ?? null;
}

/**
 * Create a source. `url` is reference metadata ONLY — it is never fetched
 * (URL ingestion is a follow-up pending SSRF guardrails); ingestion is
 * paste-text for both kinds. `created_by` is stamped DB-side via auth.uid().
 */
export async function createSource(
  input: SourceCreateInput,
  db?: SupabaseClient,
): Promise<IntelSource> {
  const { data, error } = await sources(db)
    .insert({
      name: input.name,
      kind: input.kind,
      url: input.url,
      notes: input.notes,
    })
    .select()
    .single();
  guard("create-source", error);
  return data as IntelSource;
}

/** Patch a source; absent keys stay unchanged. Null on missing id. */
export async function updateSource(
  id: string,
  patch: SourceUpdateInput,
  db?: SupabaseClient,
): Promise<IntelSource | null> {
  const row: Record<string, unknown> = { updated_at: nowIso() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.url !== undefined) row.url = patch.url;
  if (patch.notes !== undefined) row.notes = patch.notes;

  const { data, error } = await sources(db)
    .update(row)
    .eq("id", id)
    .select()
    .maybeSingle();
  guard("update-source", error);
  return (data as IntelSource | null) ?? null;
}

/**
 * Delete a source (documents/chunks cascade DB-side). Returns false when the
 * id matched nothing.
 */
export async function deleteSource(
  id: string,
  db?: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await sources(db).delete().eq("id", id).select("id");
  guard("delete-source", error);
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

/** Per-source rollup for the sources DataTable (doc/chunk/embedded counts). */
export interface SourceStats {
  source_id: string;
  document_count: number;
  chunk_count: number;
  embedded_document_count: number;
}

/**
 * Aggregate document/chunk counts for every source in one round trip
 * (documents with a `chunks(count)` embed, grouped client-side). Sources with
 * no documents are simply absent from the result.
 */
export async function listSourceStats(
  db?: SupabaseClient,
): Promise<SourceStats[]> {
  const { data, error } = await documents(db).select(
    "id, source_id, status, chunks(count)",
  );
  guard("source-stats", error);

  const bySource = new Map<string, SourceStats>();
  type StatsRow = {
    source_id: string;
    status: DocumentStatus;
    chunks: Array<{ count: number }>;
  };
  for (const row of (data ?? []) as StatsRow[]) {
    const stats = bySource.get(row.source_id) ?? {
      source_id: row.source_id,
      document_count: 0,
      chunk_count: 0,
      embedded_document_count: 0,
    };
    stats.document_count += 1;
    stats.chunk_count += row.chunks?.[0]?.count ?? 0;
    if (row.status === "embedded") stats.embedded_document_count += 1;
    bySource.set(row.source_id, stats);
  }
  return [...bySource.values()];
}

// ---------------------------------------------------------------------------
// Documents (paste-text ingestion)
// ---------------------------------------------------------------------------

/**
 * Insert a pasted document. Status starts at the DB default 'pending'; the
 * AFTER INSERT trigger enqueues the `ci_embed` job — no queue call here.
 */
export async function createDocument(
  input: DocumentCreateInput,
  db?: SupabaseClient,
): Promise<IntelDocument> {
  const { data, error } = await documents(db)
    .insert({
      source_id: input.sourceId,
      title: input.title,
      content: input.content,
    })
    .select()
    .single();
  guard("create-document", error);
  return data as IntelDocument;
}

/** Document list row — content bodies (≤500k chars each) are NOT fetched. */
export interface IntelDocumentSummary {
  id: string;
  source_id: string;
  title: string;
  status: DocumentStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
  chunk_count: number;
}

export async function listDocumentsBySource(
  sourceId: string,
  db?: SupabaseClient,
): Promise<IntelDocumentSummary[]> {
  const { data, error } = await documents(db)
    .select(
      "id, source_id, title, status, error, created_at, updated_at, chunks(count)",
    )
    .eq("source_id", sourceId)
    .order("created_at", { ascending: false });
  guard("list-documents", error);

  type ListRow = Omit<IntelDocumentSummary, "chunk_count"> & {
    chunks: Array<{ count: number }>;
  };
  return ((data ?? []) as ListRow[]).map(({ chunks: chunkCounts, ...doc }) => ({
    ...doc,
    chunk_count: chunkCounts?.[0]?.count ?? 0,
  }));
}

export async function getDocument(
  id: string,
  db?: SupabaseClient,
): Promise<IntelDocument | null> {
  const { data, error } = await documents(db)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  guard("get-document", error);
  return (data as IntelDocument | null) ?? null;
}

/** Delete a document (chunks cascade). False when the id matched nothing. */
export async function deleteDocument(
  id: string,
  db?: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await documents(db)
    .delete()
    .eq("id", id)
    .select("id");
  guard("delete-document", error);
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

// ---------------------------------------------------------------------------
// Embed status
// ---------------------------------------------------------------------------

/** Honest embedding progress for one document. */
export interface ChunkStatus {
  document_id: string;
  status: DocumentStatus;
  /** Consumer failure detail when status = 'error'. */
  error: string | null;
  chunk_count: number;
  embedded_count: number;
  /** Distinct providers across this document's chunks (mismatch surfacing). */
  embedding_models: string[];
  last_embedded_at: string | null;
}

/** Null when the document does not exist. */
export async function chunkStatus(
  documentId: string,
  db?: SupabaseClient,
): Promise<ChunkStatus | null> {
  const { data: doc, error: docError } = await documents(db)
    .select("id, status, error")
    .eq("id", documentId)
    .maybeSingle();
  guard("chunk-status", docError);
  if (!doc) return null;

  const { data: rows, error: chunkError } = await chunks(db)
    .select("embedding_model, embedded_at")
    .eq("document_id", documentId);
  guard("chunk-status", chunkError);

  type ChunkMeta = { embedding_model: string | null; embedded_at: string | null };
  const metas = (rows ?? []) as ChunkMeta[];
  const models = new Set<string>();
  let embedded = 0;
  let last: string | null = null;
  for (const meta of metas) {
    if (meta.embedding_model) models.add(meta.embedding_model);
    if (meta.embedded_at) {
      embedded += 1;
      if (last === null || meta.embedded_at > last) last = meta.embedded_at;
    }
  }

  const document = doc as { id: string; status: DocumentStatus; error: string | null };
  return {
    document_id: document.id,
    status: document.status,
    error: document.error,
    chunk_count: metas.length,
    embedded_count: embedded,
    embedding_models: [...models].sort(),
    last_embedded_at: last,
  };
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Restrict matches to one source (match_chunks filter_source_id). */
  sourceId?: string | null;
  /** Requested match count — clamped to 1..SEARCH_MAX_COUNT here AND DB-side. */
  count?: number;
}

export interface SearchChunksResult {
  /** The provider that embedded the QUERY (stub-honest: model is recorded). */
  provider: { model: string; dims: number };
  rows: MatchChunkRow[];
  /**
   * Corpus embedding models among the matches that differ from the query
   * provider — similarity across mismatched models is not meaningful; the UI
   * warns.
   */
  mismatchedModels: string[];
}

/**
 * Embed the query via the env-selected provider (stub default — zero AWS
 * calls; Bedrock only under the staged activation) and rank chunks via the
 * `match_chunks` RPC (pgvector cosine, SECURITY INVOKER — RLS applies to the
 * user client).
 *
 * Throws typed errors callers must map: NotProvisionedError (substrate
 * absent), EmbeddingConfigError (bad CI_EMBED_PROVIDER),
 * EmbeddingProviderError (backend returned garbage).
 */
export async function searchChunks(
  query: string,
  options: SearchOptions = {},
  db?: SupabaseClient,
): Promise<SearchChunksResult> {
  const provider = providerFromEnv();
  const requested = Math.trunc(options.count ?? SEARCH_DEFAULT_COUNT);
  const matchCount = Math.min(
    Math.max(Number.isFinite(requested) ? requested : SEARCH_DEFAULT_COUNT, 1),
    SEARCH_MAX_COUNT,
  );

  const [queryEmbedding] = await provider.embed([query]);

  const client = db ?? getServiceClient();
  const { data, error } = await client.schema(SCHEMA).rpc("match_chunks", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    filter_source_id: options.sourceId ?? null,
  });
  guard("search", error);

  const rows = (data ?? []) as MatchChunkRow[];
  const mismatched = new Set<string>();
  for (const row of rows) {
    if (row.embedding_model && row.embedding_model !== provider.model) {
      mismatched.add(row.embedding_model);
    }
  }

  return {
    provider: { model: provider.model, dims: provider.dims },
    rows,
    mismatchedModels: [...mismatched].sort(),
  };
}

// ---------------------------------------------------------------------------
// Keyword (FTS) search — W8R agentic retrieval candidate stage
// ---------------------------------------------------------------------------

/**
 * Rank chunks by Postgres full-text search via the `search_chunks_fts` RPC
 * (websearch_to_tsquery + ts_rank_cd, SECURITY INVOKER — RLS applies to the
 * user client). NO embedding provider involved: this is the candidate stage
 * of agentic retrieval; the dormant pgvector path (`searchChunks`) stays
 * untouched. Stopword-only queries simply yield zero rows.
 *
 * Throws NotProvisionedError when the substrate/RPC is absent (same mapping
 * as `searchChunks`); other PostgREST errors fail loud.
 */
export async function searchChunksFts(
  query: string,
  options: SearchOptions = {},
  db?: SupabaseClient,
): Promise<FtsChunkRow[]> {
  const requested = Math.trunc(options.count ?? SEARCH_DEFAULT_COUNT);
  const matchCount = Math.min(
    Math.max(Number.isFinite(requested) ? requested : SEARCH_DEFAULT_COUNT, 1),
    SEARCH_MAX_COUNT,
  );

  const client = db ?? getServiceClient();
  const { data, error } = await client
    .schema(SCHEMA)
    .rpc("search_chunks_fts", {
      query_text: query,
      match_count: matchCount,
      filter_source_id: options.sourceId ?? null,
    });
  guard("search-fts", error);

  return (data ?? []) as FtsChunkRow[];
}
