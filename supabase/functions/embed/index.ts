// Wave-8 scaffold — deterministic embedding STUB (no model, no network).
//
// POST { text } -> { model: "stub-w8", vector: number[8], note }
//
// The vector is a pure function of the input text (djb2-xor rolling hashes
// folded into 8 floats in [-1, 1]), so identical text always embeds
// identically — enough for the Wave-8 competitor-intel RAG plumbing to be
// built and tested end-to-end before a real embedding model lands.

const MODEL = "stub-w8";
const DIMS = 8;
const NOTE = "W8 scaffold — placeholder";

/** Deterministic 8-dim embedding: per-dim djb2-xor hash mapped to [-1, 1]. */
function stubEmbed(text: string): number[] {
  const vector: number[] = [];
  for (let dim = 0; dim < DIMS; dim++) {
    let h = 5381 + dim * 33;
    for (let i = 0; i < text.length; i++) {
      h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    // Map the 32-bit hash onto [-1, 1] and keep it readable in JSON.
    vector.push(Number(((h / 0xffffffff) * 2 - 1).toFixed(6)));
  }
  return vector;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ msg: "POST { text } to embed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }
  let text: unknown;
  try {
    ({ text } = await req.json());
  } catch {
    return new Response(
      JSON.stringify({ msg: "body must be JSON: { text }" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (typeof text !== "string" || text.length === 0) {
    return new Response(
      JSON.stringify({ msg: "missing/empty `text` string" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ model: MODEL, vector: stubEmbed(text), note: NOTE }),
    { headers: { "Content-Type": "application/json" } },
  );
});
