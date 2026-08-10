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
//        SearchResponse { query, mode, results, answer, degraded }
//   GET  /api/intel/search/answer/:taskId  → AnswerResponse
// Errors: { error, message? } — error === "intel-not-provisioned" (503) is
// the repo's NotProvisionedError; anything else stays a generic degraded
// state (a non-200 from the answer poll is retryable until the deadline).

import type {
  AnswerResponse,
  DocumentStatus,
  FtsChunkRow,
  IntelDocument,
  IntelSource,
  SearchAnswer,
  SearchDegraded,
  SearchMode,
  SearchResponse,
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

/**
 * Validate a wire answer object into the shapes the panel dereferences.
 * `state` alone is NOT trusted: a "completed" without a string `answer` and
 * array `citations`/`ranking` would crash the rerank memo, and a "pending"
 * without a taskId would poll `/answer/undefined` for the full deadline.
 * Malformed ⇒ null (caller degrades to keyword-only / keeps waiting).
 */
function normalizeAnswer(
  value: unknown,
): { state: "pending"; taskId: string } | ({ state: "completed" } & {
  answer: string;
  citations: number[];
  ranking: number[];
}) | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (a.state === "pending") {
    return typeof a.taskId === "string" && a.taskId.length > 0
      ? { state: "pending", taskId: a.taskId }
      : null;
  }
  if (
    a.state === "completed" &&
    typeof a.answer === "string" &&
    Array.isArray(a.citations) &&
    Array.isArray(a.ranking)
  ) {
    const nums = (arr: unknown[]) =>
      arr.filter((n): n is number => typeof n === "number");
    return {
      state: "completed",
      answer: a.answer,
      citations: nums(a.citations),
      ranking: nums(a.ranking),
    };
  }
  return null;
}

/**
 * Agentic search (Wave-8R): FTS-ranked passages arrive immediately; when the
 * gateway is configured the route also returns a pending answer taskId for
 * the panel to poll. Normalized defensively — a malformed payload degrades
 * to keyword-only with no answer, never a crash.
 */
export async function searchIntel(params: {
  q: string;
  sourceId?: string | null;
  count?: number;
}): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.sourceId) qs.set("sourceId", params.sourceId);
  if (params.count) qs.set("count", String(params.count));
  const json = (await request(`/api/intel/search?${qs.toString()}`)) as {
    query?: string;
    mode?: SearchMode;
    results?: FtsChunkRow[];
    answer?: SearchAnswer | null;
    degraded?: SearchDegraded | null;
  } | null;
  return {
    query: typeof json?.query === "string" ? json.query : params.q,
    mode: json?.mode === "agentic" ? "agentic" : "keyword-only",
    results: Array.isArray(json?.results) ? json.results : [],
    answer: normalizeAnswer(json?.answer),
    degraded:
      json?.degraded && typeof json.degraded === "object" ? json.degraded : null,
  };
}

/** Client-side bound on ONE poll round trip. The server bounds its gateway
 * leg at ~10s; this keeps a stalled proxy/relay from pinning a poll open,
 * since the panel's 90s deadline is only checked after each poll settles. */
const ANSWER_POLL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Poll the async answer for a search. 200 payloads are VALIDATED into the
 * typed AnswerResponse; a malformed body reads as `pending` (the caller's
 * deadline bounds retries). Non-200s throw IntelApiError — also retryable,
 * because the gateway itself has no failed state (see ANSWER_POLL_DEADLINE_MS).
 */
export async function pollIntelAnswer(taskId: string): Promise<AnswerResponse> {
  const json = (await request(
    `/api/intel/search/answer/${encodeURIComponent(taskId)}`,
    { signal: AbortSignal.timeout(ANSWER_POLL_FETCH_TIMEOUT_MS) },
  )) as AnswerResponse | null;
  const completed = normalizeAnswer(json);
  if (completed?.state === "completed") return completed;
  if (json && typeof json === "object" && json.state === "failed") {
    return {
      state: "failed",
      reason: typeof json.reason === "string" ? json.reason : "unknown",
    };
  }
  return { state: "pending" };
}
