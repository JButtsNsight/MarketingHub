import { describe, expect, test } from "vitest";
import {
  ANSWER_POLL_DEADLINE_MS,
  ANSWER_POLL_INTERVAL_MS,
  DOCUMENT_CONTENT_MAX_CHARS,
  DOCUMENT_STATUSES,
  DocumentCreateInputSchema,
  EMBEDDING_DIMS,
  INTEL_EMBED_QUEUE,
  INTEL_SCHEMA,
  INTEL_TASK_ID_RE,
  SEARCH_DEFAULT_COUNT,
  SEARCH_MAX_COUNT,
  SOURCE_KINDS,
  SYNTHESIS_MAX_TOKENS,
  SYNTHESIS_PROMPT_MAX_BYTES,
  SYNTHESIS_PROMPT_MAX_CHARS,
  SearchInputSchema,
  SourceCreateInputSchema,
  SourceUpdateInputSchema,
  SynthesisResultSchema,
} from "./schema";

describe("constants", () => {
  test("mirror the DB contract", () => {
    expect(INTEL_SCHEMA).toBe("competitor_intel");
    expect(INTEL_EMBED_QUEUE).toBe("ci_embed");
    expect(EMBEDDING_DIMS).toBe(1024);
    expect(SOURCE_KINDS).toEqual(["text", "url"]);
    expect(DOCUMENT_STATUSES).toEqual([
      "pending",
      "processing",
      "embedded",
      "error",
    ]);
    expect(SEARCH_MAX_COUNT).toBe(50);
    // W8R: one list serves display + synthesis (citations must point at
    // retrieved rows), so the default doubled from 8.
    expect(SEARCH_DEFAULT_COUNT).toBe(16);
  });

  test("mirror the gateway cost/latency contract", () => {
    expect(SYNTHESIS_MAX_TOKENS).toBe(1500);
    expect(SYNTHESIS_PROMPT_MAX_CHARS).toBe(150_000);
    // Serialized-byte budget: must leave real headroom under the gateway's
    // 256KB POST body limit (envelope + JSON escaping ride on top).
    expect(SYNTHESIS_PROMPT_MAX_BYTES).toBe(200_000);
    expect(SYNTHESIS_PROMPT_MAX_BYTES).toBeLessThan(256 * 1024);
    expect(ANSWER_POLL_INTERVAL_MS).toBe(3000);
    expect(ANSWER_POLL_DEADLINE_MS).toBe(90_000);
  });
});

describe("SourceCreateInputSchema", () => {
  test("minimal input defaults kind=text with null url/notes", () => {
    const parsed = SourceCreateInputSchema.parse({ name: "  Acme Corp  " });
    expect(parsed).toEqual({
      name: "Acme Corp",
      kind: "text",
      url: null,
      notes: null,
    });
  });

  test("blank optional fields become null", () => {
    const parsed = SourceCreateInputSchema.parse({
      name: "Acme",
      kind: "text",
      url: "",
      notes: "   ",
    });
    expect(parsed.url).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  test("kind=url requires a url", () => {
    const res = SourceCreateInputSchema.safeParse({
      name: "Acme",
      kind: "url",
    });
    expect(res.success).toBe(false);
  });

  test("kind=url with an https url passes", () => {
    const parsed = SourceCreateInputSchema.parse({
      name: "Acme",
      kind: "url",
      url: "https://acme.example.com/pricing",
    });
    expect(parsed.url).toBe("https://acme.example.com/pricing");
  });

  test("rejects non-http(s) urls", () => {
    for (const url of ["ftp://acme.example.com", "javascript:alert(1)", "nope"]) {
      const res = SourceCreateInputSchema.safeParse({
        name: "Acme",
        kind: "url",
        url,
      });
      expect(res.success).toBe(false);
    }
  });

  test("rejects an empty name", () => {
    expect(SourceCreateInputSchema.safeParse({ name: "  " }).success).toBe(
      false,
    );
  });
});

describe("SourceUpdateInputSchema", () => {
  test("rejects an empty patch", () => {
    expect(SourceUpdateInputSchema.safeParse({}).success).toBe(false);
  });

  test("single-field patches pass and leave other keys undefined", () => {
    const parsed = SourceUpdateInputSchema.parse({ name: "New name" });
    expect(parsed.name).toBe("New name");
    expect(parsed.url).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  test("null or blank url clears it; absent keeps it", () => {
    expect(SourceUpdateInputSchema.parse({ url: null }).url).toBeNull();
    expect(SourceUpdateInputSchema.parse({ url: "  " }).url).toBeNull();
  });

  test("rejects an invalid url in a patch", () => {
    expect(
      SourceUpdateInputSchema.safeParse({ url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});

describe("DocumentCreateInputSchema", () => {
  const valid = {
    sourceId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    title: "Q3 pricing page",
    content: "# Pricing\n\nPlan A is $10.\n",
  };

  test("accepts a valid paste and preserves content verbatim", () => {
    const parsed = DocumentCreateInputSchema.parse(valid);
    expect(parsed.content).toBe("# Pricing\n\nPlan A is $10.\n");
    expect(parsed.title).toBe("Q3 pricing page");
  });

  test("rejects whitespace-only content", () => {
    expect(
      DocumentCreateInputSchema.safeParse({ ...valid, content: " \n\t " })
        .success,
    ).toBe(false);
  });

  test("rejects content over the ceiling", () => {
    expect(
      DocumentCreateInputSchema.safeParse({
        ...valid,
        content: "x".repeat(DOCUMENT_CONTENT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  test("rejects a non-uuid sourceId", () => {
    expect(
      DocumentCreateInputSchema.safeParse({ ...valid, sourceId: "42" }).success,
    ).toBe(false);
  });
});

describe("SearchInputSchema", () => {
  test("defaults count and null sourceId", () => {
    const parsed = SearchInputSchema.parse({ q: "  pricing tiers " });
    expect(parsed).toEqual({
      q: "pricing tiers",
      sourceId: null,
      count: SEARCH_DEFAULT_COUNT,
    });
  });

  test("coerces count from query-param strings", () => {
    expect(SearchInputSchema.parse({ q: "x", count: "12" }).count).toBe(12);
  });

  test("rejects out-of-range or fractional counts", () => {
    for (const count of [0, SEARCH_MAX_COUNT + 1, "2.5"]) {
      expect(SearchInputSchema.safeParse({ q: "x", count }).success).toBe(
        false,
      );
    }
  });

  test("rejects blank q and non-uuid sourceId", () => {
    expect(SearchInputSchema.safeParse({ q: "  " }).success).toBe(false);
    expect(
      SearchInputSchema.safeParse({ q: "x", sourceId: "acme" }).success,
    ).toBe(false);
  });
});

describe("SynthesisResultSchema", () => {
  const valid = {
    answer: "Plan A costs $10 [1]. Plan B is enterprise-only [2].",
    citations: [1, 2],
    ranking: [2, 1, 3],
  };

  test("accepts a well-formed synthesis result", () => {
    expect(SynthesisResultSchema.parse(valid)).toEqual(valid);
  });

  test("accepts empty citations/ranking (no supporting passages)", () => {
    const parsed = SynthesisResultSchema.parse({
      answer: "The passages do not answer this question.",
      citations: [],
      ranking: [],
    });
    expect(parsed.citations).toEqual([]);
  });

  test("rejects an empty or oversized answer", () => {
    expect(
      SynthesisResultSchema.safeParse({ ...valid, answer: "" }).success,
    ).toBe(false);
    expect(
      SynthesisResultSchema.safeParse({ ...valid, answer: "x".repeat(8001) })
        .success,
    ).toBe(false);
  });

  test("rejects passage numbers outside 1..50 or non-integers", () => {
    for (const bad of [[0], [51], [1.5], ["2"]]) {
      expect(
        SynthesisResultSchema.safeParse({ ...valid, citations: bad }).success,
      ).toBe(false);
      expect(
        SynthesisResultSchema.safeParse({ ...valid, ranking: bad }).success,
      ).toBe(false);
    }
  });

  test("rejects more than 50 entries", () => {
    const overlong = Array.from({ length: 51 }, () => 1);
    expect(
      SynthesisResultSchema.safeParse({ ...valid, ranking: overlong }).success,
    ).toBe(false);
  });

  test("rejects missing fields", () => {
    expect(
      SynthesisResultSchema.safeParse({ answer: "x", citations: [] }).success,
    ).toBe(false);
  });
});

describe("INTEL_TASK_ID_RE", () => {
  test("matches our namespaced lowercase-uuid task ids", () => {
    expect(
      INTEL_TASK_ID_RE.test(
        "mh-intel-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      ),
    ).toBe(true);
  });

  test("rejects foreign namespaces, bare uuids and malformed ids", () => {
    // Trust boundary: the answer route uses this to keep the shared gateway
    // key from becoming an oracle over other clients' task results.
    for (const id of [
      "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "other-client-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "mh-intel-7A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D",
      "mh-intel-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/../x",
      "mh-intel-",
      "mh-intel-not-a-uuid",
      " mh-intel-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "mh-intel-7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d ",
    ]) {
      expect(INTEL_TASK_ID_RE.test(id)).toBe(false);
    }
  });
});
