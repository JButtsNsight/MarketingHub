// Browser-side client for the competitor-intel routes (/api/intel/**). All
// reads and writes go through these group-gated routes — the intel pages
// never import the server repo directly — so every state (including "schema
// not provisioned yet") arrives as an honest, typed error.
//
// Shapes mirror the route responses exactly:
//   GET  /api/intel/sources                → { sources, stats }
//   POST /api/intel/sources                → 201 { id, source }
//   GET  /api/intel/sources/:id            → { source, documents }
//   PATCH/DELETE /api/intel/sources/:id    → { source } / 204
//   POST /api/intel/documents              → 201 { id, document }
//   GET  /api/intel/documents/:id          → { document }
//   GET  /api/intel/documents/:id/status   → { status }
//   DELETE /api/intel/documents/:id        → 204
//   GET  /api/intel/search?q=&sourceId=&count= →
//        { query, provider: {model, dims}, mismatchedModels, results }
// Errors: { error, message? } — error === "intel-not-provisioned" (503) is
// the repo's NotProvisionedError; "embedding-not-configured" (503) and
// "embedding-failed" (502) stay generic degraded states.

import type {
  DocumentStatus,
  IntelDocument,
  IntelSource,
  MatchChunkRow,
} from "@/lib/intel/schema";
import type {
  ChunkStatusSummary,
  IntelDocumentSummary,
  IntelSourceSummary,
} from "./types";

export type IntelApiErrorKind = "not-provisioned" | "http" | "network";

/**
 * Typed failure for every intel API call. `not-provisioned` means the
 * `competitor_intel` schema hasn't been applied to this environment yet —
 * the UI renders a dedicated honest state for it instead of a generic error.
 */
export class IntelApiError extends Error {
  readonly kind: IntelApiErrorKind;
  readonly status: number | null;

  constructor(kind: IntelApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "IntelApiError";
    this.kind = kind;
    this.status = status;
  }
}

const NOT_PROVISIONED_CODE = "intel-not-provisioned";
const NOT_PROVISIONED_TEXT = /not provisioned/i;

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new IntelApiError("network", "Network error — please try again.");
  }
  if (res.status === 204) return null;
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? record.error : null;
    const message =
      (typeof record.message === "string" ? record.message : null) ??
      code ??
      `Request failed (${res.status}).`;
    if (code === NOT_PROVISIONED_CODE || NOT_PROVISIONED_TEXT.test(message)) {
      throw new IntelApiError("not-provisioned", message, res.status);
    }
    throw new IntelApiError("http", message, res.status);
  }
  return body;
}

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* -------------------------------- sources -------------------------------- */

/** Row of the route's `stats` array (repo SourceStats). */
interface SourceStatsRow {
  source_id: string;
  document_count: number;
  chunk_count: number;
  embedded_document_count: number;
}

export async function listSources(): Promise<IntelSourceSummary[]> {
  const json = (await request("/api/intel/sources")) as {
    sources?: IntelSource[];
    stats?: SourceStatsRow[];
  } | null;
  const sources = Array.isArray(json?.sources) ? json.sources : [];
  // Sources with no documents are absent from stats (= zero); a missing stats
  // array entirely renders as an honest "—", never invented zeros.
  const stats = Array.isArray(json?.stats) ? json.stats : null;
  return sources.map((source) => {
    const stat = stats?.find((s) => s.source_id === source.id) ?? null;
    return {
      ...source,
      document_count: stats ? (stat?.document_count ?? 0) : null,
      chunk_count: stats ? (stat?.chunk_count ?? 0) : null,
    };
  });
}

export async function getSourceWithDocuments(id: string): Promise<{
  source: IntelSource;
  documents: IntelDocumentSummary[];
}> {
  const json = (await request(`/api/intel/sources/${encodeURIComponent(id)}`)) as {
    source?: IntelSource;
    documents?: IntelDocumentSummary[];
  } | null;
  if (!json?.source) throw new IntelApiError("http", "Malformed source response.");
  return {
    source: json.source,
    documents: Array.isArray(json.documents) ? json.documents : [],
  };
}

export async function createSource(input: unknown): Promise<void> {
  await request("/api/intel/sources", jsonInit(input));
}

export async function updateSource(id: string, patch: unknown): Promise<void> {
  await request(`/api/intel/sources/${encodeURIComponent(id)}`, jsonInit(patch, "PATCH"));
}

export async function deleteSource(id: string): Promise<void> {
  await request(`/api/intel/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ------------------------------- documents ------------------------------- */

export async function createDocument(input: unknown): Promise<void> {
  await request("/api/intel/documents", jsonInit(input));
}

export async function deleteDocument(id: string): Promise<void> {
  await request(`/api/intel/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getDocument(id: string): Promise<IntelDocument> {
  const json = (await request(`/api/intel/documents/${encodeURIComponent(id)}`)) as {
    document?: IntelDocument;
  } | null;
  if (!json?.document) throw new IntelApiError("http", "Malformed document response.");
  return json.document;
}

/** Row of the status route's `status` payload (repo ChunkStatus). */
interface ChunkStatusRow {
  document_id: string;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  embedded_count: number;
  embedding_models: string[];
  last_embedded_at: string | null;
}

export async function getChunkStatus(id: string): Promise<ChunkStatusSummary> {
  const json = (await request(
    `/api/intel/documents/${encodeURIComponent(id)}/status`,
  )) as { status?: ChunkStatusRow } | null;
  const status = json?.status;
  if (!status) throw new IntelApiError("http", "Malformed status response.");
  return {
    total: status.chunk_count,
    embedded: status.embedded_count,
    models: Array.isArray(status.embedding_models) ? status.embedding_models : [],
    lastEmbeddedAt: status.last_embedded_at ?? null,
  };
}

/* --------------------------------- search -------------------------------- */

export interface SearchResult {
  rows: MatchChunkRow[];
  /** The model that embedded the QUERY, as reported by the route. */
  queryModel: string | null;
  /** Corpus models among the matches that differ from the query provider. */
  mismatchedModels: string[];
}

export async function searchIntel(params: {
  q: string;
  sourceId?: string | null;
  count?: number;
}): Promise<SearchResult> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.sourceId) qs.set("sourceId", params.sourceId);
  if (params.count) qs.set("count", String(params.count));
  const json = (await request(`/api/intel/search?${qs.toString()}`)) as {
    provider?: { model?: string };
    mismatchedModels?: string[];
    results?: MatchChunkRow[];
  } | null;
  return {
    rows: Array.isArray(json?.results) ? json.results : [],
    queryModel:
      typeof json?.provider?.model === "string" ? json.provider.model : null,
    mismatchedModels: Array.isArray(json?.mismatchedModels)
      ? json.mismatchedModels
      : [],
  };
}
