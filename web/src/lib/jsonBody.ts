/**
 * Bounded JSON request-body reader — the house guard for `await req.json()`.
 *
 * Next.js App Router route handlers impose NO request-body size limit: a bare
 * `await req.json()` buffers the ENTIRE body into memory before any schema
 * validation runs, so an authenticated caller POSTing a multi-GB envelope
 * (e.g. one giant unknown key that Zod would reject anyway) can drive the app
 * process to OOM. Neither the internal ALB nor next.config.mjs caps payload
 * size, so the guard has to live here.
 *
 * `readJsonBodyBounded` enforces the cap BEFORE parsing:
 *   1. rejects on the declared Content-Length without reading a byte, then
 *   2. streams the body with a hard cap — the moment the cap is crossed the
 *      stream is cancelled (a lying/chunked Content-Length cannot bypass it),
 *      then
 *   3. JSON-parses what was read.
 *
 * Returns a discriminated union instead of throwing: `{ ok: false, response }`
 * carries the ready-made 413 (too large) / 400 (invalid JSON) so callers stay
 * one-liners. New JSON routes should use this instead of `req.json()`;
 * existing console routes share the same unguarded pattern and should migrate
 * as they are touched.
 */

/** Default envelope cap. Individual routes may pass a tighter/looser bound. */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024;

export type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

export async function readJsonBodyBounded(
  req: Request,
  maxBytes: number = DEFAULT_JSON_BODY_LIMIT_BYTES,
): Promise<BoundedJsonResult> {
  const tooLarge = (): BoundedJsonResult => ({
    ok: false,
    response: Response.json(
      {
        error: `Request body exceeds the ${Math.floor(maxBytes / 1024)}KB limit`,
      },
      { status: 413 },
    ),
  });

  // Fast path: honest clients declare their size — reject without reading.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  // Hard cap while streaming: stop reading (and cancel the source) the moment
  // the cap is crossed, so an unbounded body is never fully buffered.
  const reader = req.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}
