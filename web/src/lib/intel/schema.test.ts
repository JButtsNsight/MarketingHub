import { describe, expect, test } from "vitest";
import {
  DOCUMENT_CONTENT_MAX_CHARS,
  DOCUMENT_STATUSES,
  DocumentCreateInputSchema,
  EMBEDDING_DIMS,
  INTEL_EMBED_QUEUE,
  INTEL_SCHEMA,
  SEARCH_DEFAULT_COUNT,
  SEARCH_MAX_COUNT,
  SOURCE_KINDS,
  SearchInputSchema,
  SourceCreateInputSchema,
  SourceUpdateInputSchema,
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
