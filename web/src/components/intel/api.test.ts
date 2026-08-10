// @vitest-environment node
//
// Locks in api.ts's documented normalization contract for the answer flow:
// "a malformed payload degrades to keyword-only with no answer, never a
// crash". State strings alone are never trusted — a `completed` without a
// ranking array would crash SearchPanel's rerank memo, and a `pending`
// without a taskId would poll /answer/undefined for the whole deadline.
import { afterEach, describe, expect, test, vi } from "vitest";
import { pollIntelAnswer, searchIntel } from "./api";

function stubJson(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

const ROW = {
  chunk_id: 1,
  document_id: "33333333-3333-4333-8333-333333333333",
  source_id: "22222222-2222-4222-8222-222222222222",
  seq: 0,
  content: "alpha",
  rank: 0.5,
  document_title: "Doc",
  source_name: "Src",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchIntel answer normalization", () => {
  test("valid pending and completed answers pass through typed", async () => {
    stubJson({
      query: "q",
      mode: "agentic",
      results: [ROW],
      answer: { state: "pending", taskId: "mh-intel-x" },
      degraded: null,
    });
    expect((await searchIntel({ q: "q" })).answer).toEqual({
      state: "pending",
      taskId: "mh-intel-x",
    });

    stubJson({
      query: "q",
      mode: "agentic",
      results: [ROW],
      answer: { state: "completed", answer: "a [1]", citations: [1], ranking: [1] },
      degraded: null,
    });
    expect((await searchIntel({ q: "q" })).answer).toEqual({
      state: "completed",
      answer: "a [1]",
      citations: [1],
      ranking: [1],
    });
  });

  test("pending without a taskId degrades to no answer (never polls undefined)", async () => {
    stubJson({
      query: "q",
      mode: "agentic",
      results: [ROW],
      answer: { state: "pending" },
      degraded: null,
    });
    expect((await searchIntel({ q: "q" })).answer).toBeNull();
  });

  test("completed missing answer/citations/ranking degrades to no answer", async () => {
    for (const answer of [
      { state: "completed" },
      { state: "completed", answer: "a", citations: [1] }, // no ranking
      { state: "completed", answer: "a", citations: "1", ranking: [1] },
      { state: "completed", answer: 42, citations: [1], ranking: [1] },
    ]) {
      stubJson({ query: "q", mode: "agentic", results: [ROW], answer, degraded: null });
      expect((await searchIntel({ q: "q" })).answer).toBeNull();
    }
  });

  test("non-number citation/ranking entries are filtered, not passed through", async () => {
    stubJson({
      query: "q",
      mode: "agentic",
      results: [ROW],
      answer: {
        state: "completed",
        answer: "a",
        citations: [1, "2", null],
        ranking: [{}, 1],
      },
      degraded: null,
    });
    expect((await searchIntel({ q: "q" })).answer).toEqual({
      state: "completed",
      answer: "a",
      citations: [1],
      ranking: [1],
    });
  });
});

describe("pollIntelAnswer normalization", () => {
  test("valid completed passes through; failed keeps its reason", async () => {
    stubJson({ state: "completed", answer: "a [1]", citations: [1], ranking: [1] });
    expect(await pollIntelAnswer("mh-intel-x")).toEqual({
      state: "completed",
      answer: "a [1]",
      citations: [1],
      ranking: [1],
    });

    stubJson({ state: "failed", reason: "synthesis-unparseable" });
    expect(await pollIntelAnswer("mh-intel-x")).toEqual({
      state: "failed",
      reason: "synthesis-unparseable",
    });
  });

  test("a completed body missing ranking reads as pending (deadline bounds it)", async () => {
    stubJson({ state: "completed", answer: "a", citations: [1] });
    expect(await pollIntelAnswer("mh-intel-x")).toEqual({ state: "pending" });
  });

  test("garbage 200 bodies read as pending, never a crash", async () => {
    for (const body of [null, "nope", { hello: 1 }, { state: "???" }]) {
      stubJson(body);
      expect(await pollIntelAnswer("mh-intel-x")).toEqual({ state: "pending" });
    }
  });
});
