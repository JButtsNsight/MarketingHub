"use client";

// Agentic search over the competitor-intel corpus (Wave-8R). Two-phase UX:
// Postgres full-text search returns keyword-ranked passages immediately; when
// the headless-claude gateway is configured the route also enqueues an async
// rerank + answer-synthesis task, which this panel polls until it completes,
// fails, or the client-owned deadline passes (the gateway has NO failed
// state — crashed tasks read `pending` forever, so the browser must stop).
//
// Follows the templates q-param precedent (the query lives in the URL, so
// results are shareable and survive reloads) but searches on explicit submit:
// every agentic query costs a gateway task, so we don't spam it per keystroke.
//
// Honesty rules carried through: keyword-only mode says plainly that no
// answer is coming, the ranking badge names who ranked the list ("Keyword
// rank" vs "Ranked by Claude"), timeout/failure keep the still-valid keyword
// results, and a missing schema renders the not-provisioned state.
//
// Trust rule: passage numbers [n] are frozen at retrieval (1-based FTS
// order). Reranking reorders the DISPLAY only — numbers travel with their
// rows — so the answer's [n] citations always name the passage the model
// actually read.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ANSWER_POLL_DEADLINE_MS,
  ANSWER_POLL_INTERVAL_MS,
  type FtsChunkRow,
  type SearchResponse,
} from "@/lib/intel/schema";
import { Badge } from "@/components/ui/Badge";
import { Surface } from "../Surface";
import { listSources, pollIntelAnswer, searchIntel, IntelApiError } from "./api";
import { RagAnswerPanel } from "./RagAnswerPanel";
import { ErrorState } from "./States";
import { KEYWORD_ONLY_TEXT } from "./status";
import type { AnswerPhase, IntelSourceSummary } from "./types";

const EXCERPT_CHARS = 600;

function excerpt(content: string): string {
  return content.length > EXCERPT_CHARS ? `${content.slice(0, EXCERPT_CHARS)}…` : content;
}

type Phase =
  | { name: "idle" }
  | { name: "loading" }
  | { name: "done"; q: string; response: SearchResponse };

export function SearchPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [sourceId, setSourceId] = useState(searchParams.get("sourceId") ?? "");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [answer, setAnswer] = useState<AnswerPhase>({ name: "none" });
  const [error, setError] = useState<IntelApiError | null>(null);
  // Filter dropdown data; a failed load hides the DROPDOWN without blocking
  // search — but an active URL filter must stay visible (no silent state).
  const [sources, setSources] = useState<IntelSourceSummary[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  // Set when the URL carried a sourceId that no longer exists — the filter
  // was dropped and the user is told, instead of every search silently
  // matching nothing against a deleted source.
  const [droppedStaleFilter, setDroppedStaleFilter] = useState(false);

  // Stale-poll guard: bumped on every new search and on unmount. A poll tick
  // (or its in-flight response) whose generation no longer matches is from a
  // superseded query — its result must never land on the current one.
  const generation = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the URL-driven initial search (declared here so the unmount
  // cleanup below can re-arm it).
  const ranInitial = useRef(false);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      // Unmount: invalidate in-flight polls and drop the scheduled tick.
      // ranInitial is re-armed too: React StrictMode's simulated
      // unmount/remount runs this cleanup once at dev mount, and without the
      // reset the remount would skip the initial URL-driven search while the
      // generation bump discards the first run's in-flight response —
      // leaving /intel/search?q=… stuck on "Searching…" forever in dev.
      // (Production single-mounts, so the reset is a no-op there.)
      generation.current += 1;
      ranInitial.current = false;
      stopPolling();
    },
    [],
  );

  const startPolling = useCallback((taskId: string, gen: number) => {
    const deadline = Date.now() + ANSWER_POLL_DEADLINE_MS;
    const tick = async () => {
      if (generation.current !== gen) return;
      try {
        const result = await pollIntelAnswer(taskId);
        if (generation.current !== gen) return; // superseded mid-flight
        if (result.state === "completed") {
          setAnswer({ name: "completed", result });
          return;
        }
        if (result.state === "failed") {
          setAnswer({ name: "failed" });
          return;
        }
      } catch {
        if (generation.current !== gen) return;
        // Non-200 polls are retryable — the deadline below bounds them.
      }
      if (Date.now() >= deadline) {
        // Honest timeout: no answer is coming (or the task silently died —
        // indistinguishable by contract). The keyword results stay.
        setAnswer({ name: "timeout" });
        return;
      }
      pollTimer.current = setTimeout(() => void tick(), ANSWER_POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(() => void tick(), ANSWER_POLL_INTERVAL_MS);
  }, []);

  const runSearch = useCallback(
    async (q: string, sid: string) => {
      generation.current += 1;
      const gen = generation.current;
      stopPolling();
      setAnswer({ name: "none" });
      const trimmed = q.trim();
      if (!trimmed) {
        setPhase({ name: "idle" });
        setError(null);
        return;
      }
      setPhase({ name: "loading" });
      setError(null);
      try {
        const response = await searchIntel({ q: trimmed, sourceId: sid || null });
        if (generation.current !== gen) return; // superseded mid-flight
        setPhase({ name: "done", q: trimmed, response });
        if (response.answer?.state === "completed") {
          // Server cache hit — the answer arrived with the results.
          setAnswer({ name: "completed", result: response.answer });
        } else if (response.answer?.state === "pending") {
          setAnswer({ name: "pending" });
          startPolling(response.answer.taskId, gen);
        } else if (response.degraded?.reason === "synthesis-unavailable") {
          // Gateway configured but the submission failed — results stand.
          setAnswer({ name: "failed" });
        }
      } catch (err) {
        if (generation.current !== gen) return;
        setPhase({ name: "idle" });
        setError(
          err instanceof IntelApiError ? err : new IntelApiError("http", "Search failed."),
        );
      }
    },
    [startPolling],
  );

  // Run once for a q that arrived in the URL (shared link / reload).
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
            // perpetual "No matches" with no cause in sight. Drop it
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

  // Display order. Passage numbers n are frozen at retrieval; a completed
  // rerank reorders rows by `ranking` (dedup, out-of-range dropped) and any
  // unranked rows keep their keyword order at the tail — never lost.
  const ordered = useMemo(() => {
    const rows = phase.name === "done" ? phase.response.results : [];
    const numbered = rows.map((row, i) => ({ row, n: i + 1 }));
    if (answer.name !== "completed") return numbered;
    // Defensive: api.ts guarantees an array, but a non-array here must fall
    // back to keyword order, never crash the whole results panel.
    const ranking = Array.isArray(answer.result.ranking)
      ? answer.result.ranking
      : [];
    const picked = new Set<number>();
    const out: typeof numbered = [];
    for (const n of ranking) {
      if (Number.isInteger(n) && n >= 1 && n <= numbered.length && !picked.has(n)) {
        picked.add(n);
        out.push(numbered[n - 1]);
      }
    }
    for (const item of numbered) {
      if (!picked.has(item.n)) out.push(item);
    }
    return out;
  }, [phase, answer]);

  const results = phase.name === "done" ? phase.response.results : [];
  const degraded = phase.name === "done" ? phase.response.degraded : null;

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
          Keyword search over everything pasted into competitor intel, with a
          Claude-synthesized, passage-cited answer when the gateway is
          configured. Results carry document and source provenance.
        </p>
      ) : null}

      {phase.name === "loading" ? <p className="muted">Searching…</p> : null}

      {phase.name === "done" ? (
        results.length === 0 ? (
          <Surface className="empty-state" glint>
            <h2>No matches</h2>
            <p>
              No passage in the corpus matched “{phase.q}”. Documents added in
              the last minute may still be waiting on the chunking worker —
              check their status on the source page.
            </p>
          </Surface>
        ) : (
          <>
            {degraded?.reason === "gateway-not-configured" ? (
              <p className="note">{KEYWORD_ONLY_TEXT}</p>
            ) : null}

            <RagAnswerPanel phase={answer} rows={results} />

            <div className="stack">
              <div className="form-actions">
                {/* Ranking provenance must be TRUE, not aspirational: the
                    model may legally omit/void `ranking` (coerced to [] by
                    the gateway parser), in which case the order below is
                    still pure keyword rank and must say so. */}
                {answer.name === "completed" &&
                Array.isArray(answer.result.ranking) &&
                answer.result.ranking.length > 0 ? (
                  <Badge
                    tone="var(--ok)"
                    title="passage order reranked by the synthesis task"
                  >
                    Ranked by Claude
                  </Badge>
                ) : (
                  <Badge title="Postgres full-text rank (ts_rank_cd)">
                    Keyword rank
                  </Badge>
                )}
              </div>
              {ordered.map(({ row, n }) => (
                <ResultCard key={row.chunk_id} row={row} n={n} />
              ))}
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

function ResultCard({ row, n }: { row: FtsChunkRow; n: number }) {
  return (
    <Surface className="panel" glint>
      <div className="panel-head">
        <div className="panel-head-text">
          <span className="eyebrow mono">
            {/* Frozen passage number — what the answer's citations refer to. */}
            [{n}] · rank {row.rank.toFixed(3)} · chunk #{row.seq}
          </span>
          <h2>
            {row.source_name} ›{" "}
            <Link href={`/intel/documents/${row.document_id}`}>{row.document_title}</Link>
          </h2>
        </div>
      </div>
      <p>{excerpt(row.content)}</p>
    </Surface>
  );
}

export default SearchPanel;
