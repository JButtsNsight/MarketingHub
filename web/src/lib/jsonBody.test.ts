// @vitest-environment node
// Request/ReadableStream come from the Node (undici) globals — same runtime
// the App Router handlers see in production.
import { describe, expect, test } from "vitest";

import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  readJsonBodyBounded,
} from "./jsonBody";

const CAP = 1024; // small cap keeps the oversize fixtures cheap

function post(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request("http://x/api/test", { method: "POST", body, headers });
}

describe("readJsonBodyBounded", () => {
  test("parses a body under the cap", async () => {
    const result = await readJsonBodyBounded(post('{"a":1}'), CAP);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  test("rejects 413 on the declared Content-Length without reading the body", async () => {
    // A stream that would explode if pulled — the declared size must short-circuit.
    const neverRead = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("body was read despite an oversize Content-Length");
      },
    });
    const req = new Request("http://x/api/test", {
      method: "POST",
      body: neverRead,
      headers: { "content-length": String(CAP + 1) },
      // @ts-expect-error -- undici extension required for stream bodies
      duplex: "half",
    });
    const result = await readJsonBodyBounded(req, CAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  test("rejects 413 mid-stream when a chunked body crosses the cap (no full buffering)", async () => {
    const chunk = new TextEncoder().encode("x".repeat(256));
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const req = new Request("http://x/api/test", {
      method: "POST",
      body: endless,
      // @ts-expect-error -- undici extension required for stream bodies
      duplex: "half",
    });
    const result = await readJsonBodyBounded(req, CAP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    // cancelled at the cap: ~cap/chunk pulls, never unbounded
    expect(pulls).toBeLessThanOrEqual(Math.ceil(CAP / chunk.byteLength) + 2);
  });

  test("rejects 400 on invalid JSON (including an empty body)", async () => {
    for (const body of ["not json", ""]) {
      const result = await readJsonBodyBounded(post(body), CAP);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(400);
        expect(await result.response.json()).toEqual({
          error: "Invalid JSON body",
        });
      }
    }
  });

  test("default cap is 256KB", () => {
    expect(DEFAULT_JSON_BODY_LIMIT_BYTES).toBe(256 * 1024);
  });
});
