// Pure module — recursive structure-aware text chunker for competitor-intel
// ingestion. No server-only or node-only imports; shared by the API routes
// (Builder D) and the worker consumer (Builder C).
//
// Strategy (W8 scout recommendation, no bikeshed): split on the strongest
// structural boundary available — markdown headings, then blank-line
// paragraphs, then single newlines, then sentence enders, then whitespace,
// then hard code-point slices — into "atoms" no larger than the chunk budget,
// and greedily pack atoms into 400–512-token chunks with ~12.5% overlap.
// Tokens are estimated at 4 characters per token (Titan-ish heuristic); the
// 512-token ceiling keeps every chunk far under Titan V2's 8K-token context.

/** Crude but stable token estimate: ~4 characters per token. */
export const CHARS_PER_TOKEN = 4;

/** Default chunk ceiling (tokens). 512 × 4 = 2048 characters. */
export const CHUNK_MAX_TOKENS = 512;

/** Default overlap between consecutive chunks (tokens) — 12.5% of the max. */
export const CHUNK_OVERLAP_TOKENS = 64;

export interface ChunkOptions {
  /** Max tokens per chunk (default {@link CHUNK_MAX_TOKENS}). */
  maxTokens?: number;
  /** Overlap carried into the next chunk (default {@link CHUNK_OVERLAP_TOKENS}). */
  overlapTokens?: number;
}

/** One chunk, ready for `competitor_intel.chunks` (seq, content, estimate). */
export interface TextChunk {
  seq: number;
  content: string;
  tokenEstimate: number;
}

/** Estimated token count for a string (ceil of chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Boundary patterns, strongest first. Every pattern is zero-width (lookahead
 * or lookbehind), so `text.split(pattern)` pieces concatenate back to the
 * exact input — nothing is dropped, boundaries just choose where to cut:
 *  1. before a markdown heading line
 *  2. after a blank line (paragraph break)
 *  3. after a newline
 *  4. between a sentence ender and following whitespace
 *  5. after any whitespace (word boundary)
 */
const BOUNDARIES: readonly RegExp[] = [
  /(?=^#{1,6}\s)/m,
  /(?<=\n[ \t]*\n)/,
  /(?<=\n)/,
  /(?<=[.!?])(?=\s)/,
  /(?<=\s)/,
];

/** Slice into ≤ maxChars pieces at code-point boundaries (never mid-surrogate). */
function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const codePoint of text) {
    if (piece.length + codePoint.length > maxChars) {
      pieces.push(piece);
      piece = "";
    }
    piece += codePoint;
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

/**
 * Recursively split until every atom fits maxChars, preferring the strongest
 * structural boundary that actually divides the text.
 */
function atomize(text: string, level: number, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  if (level >= BOUNDARIES.length) return hardSplit(text, maxChars);
  const parts = text.split(BOUNDARIES[level]).filter((part) => part.length > 0);
  if (parts.length <= 1) return atomize(text, level + 1, maxChars);
  return parts.flatMap((part) =>
    part.length <= maxChars ? [part] : atomize(part, level + 1, maxChars),
  );
}

function requirePositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer (got ${value})`);
  }
}

/**
 * Chunk a document into 400–512-token (by default) pieces with ~10–15%
 * overlap. Returns `[]` for empty/whitespace-only input. `seq` is dense from
 * 0; `content` is trimmed; `tokenEstimate` = ceil(content.length / 4).
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxTokens = options.maxTokens ?? CHUNK_MAX_TOKENS;
  const overlapTokens = options.overlapTokens ?? CHUNK_OVERLAP_TOKENS;
  requirePositiveInt(maxTokens, "maxTokens");
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0) {
    throw new RangeError(
      `overlapTokens must be a non-negative integer (got ${overlapTokens})`,
    );
  }
  if (overlapTokens >= maxTokens) {
    throw new RangeError(
      `overlapTokens (${overlapTokens}) must be smaller than maxTokens (${maxTokens})`,
    );
  }

  if (text.trim().length === 0) return [];

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const atoms = atomize(text, 0, maxChars);

  const chunks: TextChunk[] = [];
  const emit = (windowAtoms: string[]): void => {
    const content = windowAtoms.join("").trim();
    if (content.length === 0) return;
    chunks.push({
      seq: chunks.length,
      content,
      tokenEstimate: estimateTokens(content),
    });
  };

  let window: string[] = [];
  let windowLen = 0;
  for (const atom of atoms) {
    if (windowLen + atom.length > maxChars && window.length > 0) {
      emit(window);
      // Seed the next chunk with whole trailing atoms of the previous one,
      // up to the overlap budget (whole atoms only — never mid-word slices).
      const seed: string[] = [];
      let seedLen = 0;
      for (let i = window.length - 1; i >= 0; i--) {
        const candidate = window[i];
        if (seedLen + candidate.length > overlapChars) break;
        seed.unshift(candidate);
        seedLen += candidate.length;
      }
      window = seed;
      windowLen = seedLen;
      // If the seed would push this atom over budget, forgo the overlap.
      if (windowLen + atom.length > maxChars) {
        window = [];
        windowLen = 0;
      }
    }
    window.push(atom);
    windowLen += atom.length;
  }
  emit(window);

  return chunks;
}
