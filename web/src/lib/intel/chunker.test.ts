import { describe, expect, test } from "vitest";
import {
  CHARS_PER_TOKEN,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  chunkText,
  estimateTokens,
} from "./chunker";

const MAX_CHARS = CHUNK_MAX_TOKENS * CHARS_PER_TOKEN; // 2048
const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN; // 256

/** Length of the longest suffix of `a` that is a prefix of `b`. */
function suffixPrefixOverlap(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let len = max; len > 0; len--) {
    if (a.endsWith(b.slice(0, len))) return len;
  }
  return 0;
}

/** Detects lone (unpaired) UTF-16 surrogates — i.e. a mid-emoji cut. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("estimateTokens", () => {
  test("ceil of chars / 4, zero for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("chunkText — empty and small inputs", () => {
  test("empty and whitespace-only input yield no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  \n")).toEqual([]);
  });

  test("a short document is a single trimmed chunk", () => {
    const chunks = chunkText("  Hello world.  ");
    expect(chunks).toEqual([
      { seq: 0, content: "Hello world.", tokenEstimate: 3 },
    ]);
  });
});

describe("chunkText — structural boundaries", () => {
  const sentence =
    "Competitor pricing moved again this quarter and the team took note. ";
  const section = (n: number) => `# Section ${n}\n${sentence.repeat(22)}`;
  const doc = [section(1), section(2), section(3)].join("\n");

  test("splits on headings, keeping each section intact", () => {
    const chunks = chunkText(doc);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content.startsWith("# Section 1")).toBe(true);
    expect(chunks[1].content.startsWith("# Section 2")).toBe(true);
    expect(chunks[2].content.startsWith("# Section 3")).toBe(true);
  });

  test("no chunk exceeds the character budget", () => {
    for (const chunk of chunkText(doc)) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  test("paragraph breaks are used when there are no headings", () => {
    const para = `${sentence.repeat(20).trim()}\n\n`;
    const chunks = chunkText(para.repeat(4));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS);
      // Every chunk starts at a paragraph start, not mid-sentence.
      expect(chunk.content.startsWith("Competitor pricing")).toBe(true);
    }
  });
});

describe("chunkText — overlap", () => {
  const doc = Array.from(
    { length: 200 },
    (_, i) => `Sentence number ${String(i).padStart(3, "0")} ends here.`,
  ).join(" ");

  test("consecutive chunks share a bounded overlap region", () => {
    const chunks = chunkText(doc);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 0; i + 1 < chunks.length; i++) {
      const overlap = suffixPrefixOverlap(
        chunks[i].content,
        chunks[i + 1].content,
      );
      // At least one whole sentence carried over, never more than the budget.
      expect(overlap).toBeGreaterThanOrEqual(20);
      expect(overlap).toBeLessThanOrEqual(OVERLAP_CHARS);
    }
  });

  test("covers the whole document from first to last sentence", () => {
    const chunks = chunkText(doc);
    expect(chunks[0].content).toContain("Sentence number 000");
    expect(chunks[chunks.length - 1].content).toContain("Sentence number 199");
    // All 200 sentences land in at least one chunk.
    const all = chunks.map((c) => c.content).join("\n");
    for (let i = 0; i < 200; i++) {
      expect(all).toContain(`Sentence number ${String(i).padStart(3, "0")}`);
    }
  });

  test("seq is dense from 0 and tokenEstimate matches the content", () => {
    const chunks = chunkText(doc);
    chunks.forEach((chunk, i) => {
      expect(chunk.seq).toBe(i);
      expect(chunk.tokenEstimate).toBe(
        Math.ceil(chunk.content.length / CHARS_PER_TOKEN),
      );
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS);
    });
  });
});

describe("chunkText — unicode", () => {
  test("never splits surrogate pairs and loses nothing on hard splits", () => {
    // No whitespace, no sentence enders: forces the hard code-point split.
    const text = "😀🎉🚀🥐".repeat(1500); // length 12000 (all surrogate pairs)
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(LONE_SURROGATE.test(chunk.content)).toBe(false);
    }
    // Atoms here exceed the overlap budget, so chunks are disjoint and
    // must reassemble the exact input.
    expect(chunks.map((c) => c.content).join("")).toBe(text);
  });

  test("CJK text chunks without corruption", () => {
    const text = "競合他社の価格が変わった。".repeat(400);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(LONE_SURROGATE.test(chunk.content)).toBe(false);
    }
  });
});

describe("chunkText — options", () => {
  test("custom budgets are honored", () => {
    const chunks = chunkText("alpha beta gamma delta", {
      maxTokens: 2,
      overlapTokens: 0,
    });
    expect(chunks.map((c) => c.content)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  test("rejects invalid budgets with a RangeError", () => {
    expect(() => chunkText("x", { maxTokens: 0 })).toThrow(RangeError);
    expect(() => chunkText("x", { maxTokens: 12.5 })).toThrow(RangeError);
    expect(() => chunkText("x", { overlapTokens: -1 })).toThrow(RangeError);
    expect(() =>
      chunkText("x", { maxTokens: 10, overlapTokens: 10 }),
    ).toThrow(RangeError);
  });
});
