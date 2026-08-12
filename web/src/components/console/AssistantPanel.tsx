"use client";

// Console SQL assistant rail panel (Round 2 Track C2 — the W7 "Supabase AI"
// equivalent on headless-claude). Single Q→A, ephemeral: a new question
// replaces the last answer; there is no chat history.
//
// Security posture (non-negotiable): the assistant NEVER executes SQL. A
// proposal REPLACES the editor document via onInsert (SqlConsole's updateDoc,
// which also disarms any pending write confirm) and the user's Run flows
// through the existing classify → confirm-write handshake.
// The explanation renders as PLAIN TEXT (no markdown, no links): the model
// read untrusted schema metadata, so its output gets no markup channel here.
//
// Poll loop copied from components/intel/SearchPanel.tsx: stale-poll
// generation guard, setTimeout chain, and the CLIENT-owned 90 s deadline —
// the gateway has no failed state, so a crashed task reads `pending` forever
// and the browser must stop on its own. Like SearchPanel, the input never
// locks while a task is pending: submitting again bumps the generation and
// SUPERSEDES the in-flight poll, so a mistyped question (or a silently dead
// task) never holds the panel hostage for the full deadline.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ASSISTANT_POLL_DEADLINE_MS,
  ASSISTANT_POLL_INTERVAL_MS,
  askAssistant,
  pollAssistantAnswer,
  type AssistantProposal,
} from "./assistantApi";

// Honesty copy — terse by decree, exported for tests.

/** Gateway env absent / submissions unavailable — honest one-liner. */
export const ASSISTANT_UNAVAILABLE_TEXT = "Assistant unavailable.";
/** Submitted; the gateway is answering asynchronously. */
export const ASSISTANT_PENDING_TEXT = "Thinking…";
/** The gateway returned, but no usable answer came back. */
export const ASSISTANT_FAILED_TEXT = "No usable answer — ask again.";
/** Client-owned deadline elapsed (the gateway has no failed state). */
export const ASSISTANT_TIMEOUT_TEXT = "No answer within 90 seconds.";
/** Request/network failure — terse, no internals. */
export const ASSISTANT_ERROR_TEXT = "Request failed — try again.";

type Phase =
  | { name: "idle" }
  | { name: "pending" }
  | { name: "completed"; result: AssistantProposal }
  | { name: "unavailable" }
  | { name: "failed" }
  | { name: "timeout" }
  | { name: "error" };

export function AssistantPanel({
  onInsert,
}: {
  onInsert: (sql: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  // Stale-poll guard: bumped on every new question and on unmount. A poll
  // tick (or its in-flight response) whose generation no longer matches is
  // from a superseded question — its result must never land on the current
  // one.
  const generation = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      // Unmount: invalidate in-flight polls and drop the scheduled tick.
      generation.current += 1;
      stopPolling();
    },
    [],
  );

  const startPolling = useCallback((taskId: string, gen: number) => {
    const deadline = Date.now() + ASSISTANT_POLL_DEADLINE_MS;
    const tick = async () => {
      if (generation.current !== gen) return;
      try {
        const result = await pollAssistantAnswer(taskId);
        if (generation.current !== gen) return; // superseded mid-flight
        if (result.state === "completed") {
          setPhase({ name: "completed", result });
          return;
        }
        if (result.state === "failed") {
          // The answer relay reports env-absent as a failed poll — map it to
          // the same honest one-liner as a degraded submission.
          setPhase(
            result.reason === "gateway-not-configured"
              ? { name: "unavailable" }
              : { name: "failed" },
          );
          return;
        }
      } catch {
        if (generation.current !== gen) return;
        // Non-200 polls are retryable — the deadline below bounds them.
      }
      if (Date.now() >= deadline) {
        // Honest timeout: no answer is coming (or the task silently died —
        // indistinguishable by contract).
        setPhase({ name: "timeout" });
        return;
      }
      pollTimer.current = setTimeout(() => void tick(), ASSISTANT_POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(() => void tick(), ASSISTANT_POLL_INTERVAL_MS);
  }, []);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    generation.current += 1;
    const gen = generation.current;
    stopPolling();
    setPhase({ name: "pending" });
    void (async () => {
      try {
        const response = await askAssistant(trimmed);
        if (generation.current !== gen) return; // superseded mid-flight
        if (response.answer?.state === "completed") {
          // Server cache hit — the answer arrived with the response.
          setPhase({ name: "completed", result: response.answer });
        } else if (response.answer?.state === "pending") {
          startPolling(response.answer.taskId, gen);
        } else if (response.degraded) {
          setPhase({ name: "unavailable" });
        } else {
          // Contract breakage (no answer, no degraded marker) reads as a
          // failed answer, never a crash.
          setPhase({ name: "failed" });
        }
      } catch {
        if (generation.current !== gen) return;
        setPhase({ name: "error" });
      }
    })();
  };

  return (
    <div className="nav-group">
      <span className="nav-group-label">Assistant</span>
      <form className="assistant-form" role="search" onSubmit={onSubmit}>
        <input
          className="surface control"
          type="search"
          aria-label="Ask the assistant"
          placeholder="Ask about this database…"
          maxLength={2000}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="type-chip" disabled={!question.trim()}>
          Ask
        </button>
      </form>

      {phase.name === "pending" ? (
        <p className="assistant-note">{ASSISTANT_PENDING_TEXT}</p>
      ) : null}
      {phase.name === "unavailable" ? (
        <p className="assistant-note">{ASSISTANT_UNAVAILABLE_TEXT}</p>
      ) : null}
      {phase.name === "failed" ? (
        <p className="assistant-note" role="alert">
          {ASSISTANT_FAILED_TEXT}
        </p>
      ) : null}
      {phase.name === "timeout" ? (
        <p className="assistant-note" role="alert">
          {ASSISTANT_TIMEOUT_TEXT}
        </p>
      ) : null}
      {phase.name === "error" ? (
        <p className="assistant-note" role="alert">
          {ASSISTANT_ERROR_TEXT}
        </p>
      ) : null}
      {phase.name === "completed" ? (
        <AnswerBlock result={phase.result} onInsert={onInsert} />
      ) : null}
    </div>
  );
}

function AnswerBlock({
  result,
  onInsert,
}: {
  result: AssistantProposal;
  onInsert: (sql: string) => void;
}) {
  const { explanation, sql } = result;
  return (
    <div className="assistant-answer">
      {/* Plain text by design — markdown/URLs render as inert characters. */}
      <p className="assistant-explanation">{explanation}</p>
      {sql !== null ? (
        <>
          <pre className="assistant-sql mono">{sql}</pre>
          {/* Insert-not-run: the ONLY action, and the label is honest — the
              proposal REPLACES the editor document (snippet/history idiom).
              Running stays the editor's classify → confirm-write flow. */}
          <button type="button" className="type-chip" onClick={() => onInsert(sql)}>
            Replace editor
          </button>
        </>
      ) : null}
    </div>
  );
}

export default AssistantPanel;
