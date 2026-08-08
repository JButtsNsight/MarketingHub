import { z } from "zod";

import { AuthError, requireUser } from "@/lib/auth";
import { readJsonBodyBounded } from "@/lib/jsonBody";
import { getServiceClient } from "@/lib/supabase";

/**
 * Edge Functions → invoke tester (Studio parity, Wave 5).
 *
 * POSTing here runs one registered edge function through Kong
 * (`${SUPABASE_URL}/functions/v1/<name>`) from the SERVER — the browser can
 * never reach Kong directly. Gated on the Cognito `marketing` group like every
 * console route.
 *
 * Containment:
 * - The function name is validated against `marketinghub.edge_functions` (the
 *   registry the staged host script seeds) — anything unregistered is a 404,
 *   so this endpoint can only reach paths we deliberately deployed.
 * - The upstream request is built from scratch: NO client header is ever
 *   forwarded (no cookies, no Authorization, no x-amzn-oidc-*). The Kong
 *   functions route is cors-only with VERIFY_JWT=false, so no key header is
 *   attached either — the service key never rides along to function code.
 * - Bounded: 20s AbortController timeout, a 256KB request ENVELOPE cap
 *   enforced BEFORE parsing (readJsonBodyBounded — a multi-GB body is
 *   rejected 413 without ever being buffered), a 32KB cap on the forwarded
 *   `body` field, and a 64KB response-body cap (streamed, then cancelled — a
 *   runaway function can't balloon this process).
 *
 * Error mapping: SUPABASE_URL unset → 503 {reason}; registry unreadable
 * (migration not applied yet) → 503 {reason}; network failure / timeout →
 * 502 {reason} so the console can render an honest "edge runtime down" state
 * (the container is a KNOWN restart-loop until the staged fix is applied).
 */

export const dynamic = "force-dynamic";

const MARKETING_GROUP = "marketing";
const SCHEMA = "marketinghub";
const REGISTRY_TABLE = "edge_functions";

const INVOKE_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
// Envelope cap for the WHOLE request body, applied before JSON.parse. Must
// comfortably fit a 32KB `body` field even fully JSON-escaped (\uXXXX inflates
// up to 6x) plus the other fields — 256KB does, while still bounding memory.
const MAX_ENVELOPE_BYTES = 256 * 1024;

function authErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  throw err;
}

/** RFC 7231 media-type shape (token "/" token, optional params), no CR/LF. */
const MEDIA_TYPE_RE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[ -~\t]*)?$/;

// Strict: unknown keys are a 400, so nothing can smuggle extra fetch options.
const PostBodySchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9_-]{1,64}$/,
        "name must be 1-64 chars of [a-z0-9_-] (no slashes, no dots)",
      ),
    method: z.enum(["GET", "POST"]).default("POST"),
    body: z
      .string()
      .max(MAX_REQUEST_BODY_BYTES) // UTF-16 units <= UTF-8 bytes: cheap pre-filter
      .refine(
        (b) => new TextEncoder().encode(b).length <= MAX_REQUEST_BODY_BYTES,
        { message: "body exceeds the 32KB request cap" },
      )
      .optional(),
    contentType: z
      .string()
      .max(120)
      .regex(MEDIA_TYPE_RE, "contentType must be a plain media type")
      .default("application/json"),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.method === "GET" && val.body !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "GET invocations cannot carry a body",
      });
    }
  });

/**
 * Is `name` a registered edge function? The REGISTRY (not the filesystem —
 * app containers can't read the host volume) is the allowlist. Reads via the
 * service client: the registry is platform metadata, not user-scoped data.
 */
async function isRegistered(name: string): Promise<boolean> {
  const db = getServiceClient();
  const { data, error } = await db
    .schema(SCHEMA)
    .from(REGISTRY_TABLE)
    .select("name")
    .eq("name", name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

/**
 * Read up to `capBytes` of the upstream body, then cancel the stream. A cut
 * mid-multibyte-char at the cap edge is acceptable — the cap is a safety
 * bound, not a formatting guarantee.
 */
async function readBodyCapped(
  res: Response,
  capBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };

  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > capBytes) {
      const keep = value.byteLength - (bytes - capBytes);
      text += decoder.decode(value.subarray(0, keep), { stream: true });
      await reader.cancel().catch(() => {});
      return { text, truncated: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated: false };
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser(req.headers, MARKETING_GROUP);
  } catch (err) {
    return authErrorResponse(err);
  }

  // Bounded read BEFORE parse: a bare req.json() would buffer an arbitrarily
  // large body into memory before Zod ever rejects it (OOM lever).
  const read = await readJsonBodyBounded(req, MAX_ENVELOPE_BYTES);
  if (!read.ok) return read.response;
  const parsed = PostBodySchema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { name, method, body, contentType } = parsed.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    return Response.json(
      { reason: "SUPABASE_URL is unset — edge-function invocation is not configured on this deployment." },
      { status: 503 },
    );
  }

  // Registry allowlist check. An unreadable registry (table not migrated yet)
  // is a config gap, not a caller error — honest 503, same family as the env
  // checks above.
  let registered: boolean;
  try {
    registered = await isRegistered(name);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        reason:
          "Edge-function registry unavailable — the Wave-5 migration " +
          `(marketinghub.edge_functions) may not be applied yet. (${detail})`,
      },
      { status: 503 },
    );
  }
  if (!registered) {
    return Response.json(
      { error: `No edge function named "${name}" in the registry.` },
      { status: 404 },
    );
  }

  const url = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/${name}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    // Built from scratch on purpose: the client's cookies / Authorization /
    // ALB identity headers are NEVER forwarded to function code.
    const headers: Record<string, string> = {};
    if (method === "POST") headers["content-type"] = contentType;

    const upstream = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? body : undefined,
      signal: controller.signal,
      redirect: "manual", // report 3xx as-is; never follow a function's redirect
    });
    const { text, truncated } = await readBodyCapped(
      upstream,
      MAX_RESPONSE_BODY_BYTES,
    );
    return Response.json({
      status: upstream.status,
      durationMs: Date.now() - startedAt,
      contentType: upstream.headers.get("content-type"),
      body: text,
      truncated,
    });
  } catch (err) {
    const timedOut =
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError");
    const reason = timedOut
      ? `Edge runtime did not respond within ${INVOKE_TIMEOUT_MS / 1000}s (timed out).`
      : `Edge runtime unreachable: ${err instanceof Error ? err.message : String(err)}`;
    return Response.json({ reason }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
