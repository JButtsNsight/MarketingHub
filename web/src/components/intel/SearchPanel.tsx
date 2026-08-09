"use client";

// Semantic search over the competitor-intel corpus. Follows the templates
// q-param precedent (the query lives in the URL, so results are shareable and
// survive reloads) but searches on explicit submit rather than per keystroke:
// every query costs an embedding call (Bedrock once enabled), so we don't
// spam the provider while someone types.
//
// Honesty rules carried through: the provider badge labels stub mode plainly,
// a corpus/query model mismatch gets a visible warning (similarities across
// models are not comparable), zero matches distinguishes "nothing embedded
// yet" from "no hits", and a missing schema renders the not-provisioned state.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MatchChunkRow } from "@/lib/intel/schema";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "../Surface";
import { listSources, searchIntel, IntelApiError, type SearchResult } from "./api";
import { ProviderBadge } from "./ProviderBadge";
import { ErrorState } from "./States";
import type { EmbeddingProviderInfo, IntelSourceSummary } from "./types";

const EXCERPT_CHARS = 600;

function excerpt(content: string): string {
  return content.length > EXCERPT_CHARS ? `${content.slice(0, EXCERPT_CHARS)}…` : content;
}

type Phase =
  | { name: "idle" }
  | { name: "loading" }
  | { name: "done"; q: string; result: SearchResult };

export function SearchPanel({ provider }: { provider: EmbeddingProviderInfo }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [error, setError] = useState<IntelApiError | null>(null);
  // Filter dropdown data; a failed load hides the DROPDOWN without blocking
  // search — but an active URL filter must stay visible (no silent state).
  const [sources, setSources] = useState<IntelSourceSummary[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  // Set when the URL carried a sourceId that no longer exists — the filter
  // was dropped and the user is told, instead of every search silently
  // matching nothing against a deleted source.
  const [droppedStaleFilter, setDroppedStaleFilter] = useState(false);

  const runSearch = useCallback(async (q: string, sid: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setPhase({ name: "idle" });
      setError(null);
      return;
    }
    setPhase({ name: "loading" });
    setError(null);
    try {
      const result = await searchIntel({ q: trimmed, sourceId: sid || null });
      setPhase({ name: "done", q: trimmed, result });
    } catch (err) {
      setPhase({ name: "idle" });
      setError(
        err instanceof IntelApiError ? err : new IntelApiError("http", "Search failed."),
      );
    }
  }, []);

  // Run once for a q that arrived in the URL (shared link / reload).
  const ranInitial = useRef(false);
  useEffect(() => {
    if (ranInitial.current) return;
    ranInitial.current = true;
    if (query.trim()) void runSearch(query, sourceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listSources()
      .then((list) => {
        setSources(list);
        setSourcesFailed(false);
        setSourceId((current) => {
          if (current && !list.some((s) => s.id === current)) {
            // The URL's sourceId matches nothing (deleted source / stale
            // share link). Keeping it would silently filter every search by
            // a dead uuid while the dropdown reads "All sources" — a
            // perpetual "No matches" that blames embedding lag. Drop it
            // visibly and re-run any active query unfiltered.
            setDroppedStaleFilter(true);
            if (query.trim()) void runSearch(query, "");
            return "";
          }
          return current;
        });
      })
      .catch(() => {
        setSources(null);
        setSourcesFailed(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const trimmed = query.trim();
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    if (sourceId) params.set("sourceId", sourceId);
    else params.delete("sourceId");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
    void runSearch(query, sourceId);
  };

  // The server-reported query model wins over the render-time env snapshot.
  const queryModel =
    (phase.name === "done" ? phase.result.queryModel : null) ?? provider.model;
  const mismatched =
    phase.name === "done"
      ? phase.result.rows.filter(
          (row) => row.embedding_model !== null && row.embedding_model !== queryModel,
        )
      : [];

  return (
    <div className="stack">
      <form className="search-bar surface control" onSubmit={onSubmit} role="search">
        <input
          type="search"
          aria-label="Search competitor intel"
          placeholder="Ask about the competitor corpus…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {sources && sources.length > 0 ? (
          <select
            aria-label="Filter by source"
            className="surface control"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <button type="submit" className="btn-primary">
          Search
        </button>
      </form>

      <div className="form-actions">
        <ProviderBadge info={provider} />
      </div>

      {droppedStaleFilter ? (
        <p className="note" role="alert">
          The source filter from this link no longer exists — it was cleared,
          and results now cover all sources.
        </p>
      ) : null}

      {sourcesFailed && sourceId ? (
        // The dropdown could not load, so it cannot RENDER the active filter —
        // surface it as text instead of silently restricting every search.
        <p className="note" role="alert">
          Results are filtered to one source (id {sourceId}), but the source
          list could not be loaded to show it.{" "}
          <button
            type="button"
            className="type-chip"
            onClick={() => setSourceId("")}
          >
            Clear filter
          </button>
        </p>
      ) : null}

      {error ? <ErrorState error={error} onRetry={() => void runSearch(query, sourceId)} /> : null}

      {phase.name === "idle" && !error ? (
        <p className="muted">
          Semantic search over everything pasted into competitor intel. Results
          rank by cosine similarity with document and source provenance.
        </p>
      ) : null}

      {phase.name === "loading" ? <p className="muted">Searching…</p> : null}

      {phase.name === "done" ? (
        phase.result.rows.length === 0 ? (
          <Surface className="empty-state" glint>
            <h2>No matches</h2>
            <p>
              Nothing in the embedded corpus matched “{phase.q}”. Documents
              added recently may still be awaiting embedding — check their
              status on the source page.
            </p>
          </Surface>
        ) : (
          <div className="stack">
            {mismatched.length > 0 ? (
              <p className="note" role="alert">
                {mismatched.length} of {phase.result.rows.length} results were
                embedded with a different model than the current query provider
                ({queryModel ?? "unknown"}) — similarity is not comparable
                across models. Re-embed those documents to fix ranking.
              </p>
            ) : null}
            {phase.result.rows.map((row) => (
              <ResultCard key={row.chunk_id} row={row} queryModel={queryModel} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ResultCard({
  row,
  queryModel,
}: {
  row: MatchChunkRow;
  queryModel: string | null;
}) {
  return (
    <Surface className="panel" glint>
      <div className="panel-head">
        <div className="panel-head-text">
          <span className="eyebrow mono">
            {/* Raw cosine similarity, honestly signed: 1 − distance ranges
                over [-1, 1], so a "% match" framing would print negative or
                eyebrow-raising percentages (routine with stub vectors and
                possible with real ones on dissimilar content). */}
            cosine {row.similarity.toFixed(3)} · chunk #{row.seq}
          </span>
          <h2>
            {row.source_name} ›{" "}
            <Link href={`/intel/documents/${row.document_id}`}>{row.document_title}</Link>
          </h2>
        </div>
        <div className="panel-actions">
          {row.embedding_model !== null && row.embedding_model !== queryModel ? (
            <Badge tone="var(--warn)" title="embedded with a different model than the query">
              {row.embedding_model}
            </Badge>
          ) : null}
        </div>
      </div>
      <p>{excerpt(row.content)}</p>
    </Surface>
  );
}

export default SearchPanel;
